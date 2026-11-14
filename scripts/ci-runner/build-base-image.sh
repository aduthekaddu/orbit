#!/usr/bin/env bash
# Builds the base disk image that runner-up's KVM places boot for each CI job.
#
#   build-base-image.sh CLOUD_IMAGE OUTPUT.qcow2
#
# Run it as the ci user (member of kvm), with the ci-guard firewall loaded. CLOUD_IMAGE is
# Ubuntu's noble server cloud image, already checked against its signed SHA256SUMS. The VM
# installs everything from cloud-init, prints a result line on its serial console, and
# powers off. OUTPUT is one flat qcow2 with no backing file.
set -euo pipefail

[ $# -eq 2 ] || { echo "usage: $0 CLOUD_IMAGE OUTPUT.qcow2" >&2; exit 2; }
cloud_image=$(realpath "$1")
output=$2
[ ! -e "$output" ] || { echo "$output already exists" >&2; exit 1; }

work=$(mktemp -d)
seed_pid=""
qemu_pid=""
cleanup() {
  [ -z "$qemu_pid" ] || kill "$qemu_pid" 2>/dev/null || true
  [ -z "$seed_pid" ] || kill "$seed_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

mkdir "$work/seed"
printf 'instance-id: ci-image-build-%s\nlocal-hostname: ci-image-build\n' "$(date +%s)" > "$work/seed/meta-data"
: > "$work/seed/vendor-data"
cat > "$work/seed/user-data" <<'USERDATA'
#cloud-config
users: []
ssh_pwauth: false
disable_root: true
write_files:
  # Jobs resolve names through public DNS servers, never through QEMU's forwarder to the
  # host's resolver, which knows the host's private names (the ci-guard firewall refuses it).
  - path: /etc/cloud/cloud.cfg.d/99-ci-network.cfg
    content: |
      network:
        version: 2
        ethernets:
          ci-nic:
            match:
              name: "en*"
            dhcp4: true
            dhcp4-overrides:
              use-dns: false
            dhcp6: false
            accept-ra: false
  - path: /etc/systemd/resolved.conf.d/ci-dns.conf
    content: |
      [Resolve]
      DNS=1.1.1.1 9.9.9.9 8.8.8.8
      Domains=~.
  - path: /root/build.sh
    permissions: "0700"
    content: |
      #!/bin/bash
      set -euxo pipefail
      export DEBIAN_FRONTEND=noninteractive
      # This boot already took DNS from DHCP. Use the public servers written above instead.
      systemctl restart systemd-resolved
      for link in /sys/class/net/en*; do resolvectl dns "${link##*/}" ""; done
      resolvectl status | grep -E "DNS Servers|Current DNS" || true
      apt-get update
      apt-get install -y ca-certificates curl gnupg
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
      echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
      echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
      apt-get update
      apt-get -y full-upgrade
      apt-get install -y --no-install-recommends \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
        google-chrome-stable git curl jq unzip zip zstd xz-utils build-essential python3 \
        iproute2 libicu74 libkrb5-3 zlib1g libssl3t64 liblttng-ust1t64
      systemctl enable docker.service containerd.service
      # GitHub's image has a system Node.js, and CodeQL's JavaScript extractor runs node from
      # PATH without setup-node. Jobs that run setup-node put their own version first.
      curl -fsSLo /tmp/node-SHASUMS256.txt https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
      node_tar=$(grep -oE 'node-v22\.[0-9.]+-linux-x64\.tar\.xz' /tmp/node-SHASUMS256.txt | head -1)
      curl -fsSLo "/tmp/$node_tar" "https://nodejs.org/dist/latest-v22.x/$node_tar"
      (cd /tmp && grep " $node_tar\$" node-SHASUMS256.txt | sha256sum -c -)
      tar -xJf "/tmp/$node_tar" -C /usr/local --strip-components=1 --no-same-owner
      rm -f "/tmp/$node_tar" /tmp/node-SHASUMS256.txt
      node --version
      # GitHub's runner image has user runner (uid 1001) in the docker group. The per-job
      # cloud-init seed only adds its key and sudo rule to an existing user.
      useradd --create-home --uid 1001 --shell /bin/bash --groups docker runner
      echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-runner
      chmod 0440 /etc/sudoers.d/90-runner
      # As on GitHub's ubuntu-24.04 image, so browsers and sandboxes can use user namespaces.
      echo 'kernel.apparmor_restrict_unprivileged_userns = 0' > /etc/sysctl.d/60-ci.conf
      # Guest swap lives on the job's disk overlay, not in the host's memory.
      fallocate -l 4G /swapfile
      chmod 0600 /swapfile
      mkswap /swapfile
      echo '/swapfile none swap sw 0 0' >> /etc/fstab
      apt-get clean
      rm -rf /var/lib/apt/lists/*
      cat > /root/finish.sh <<'FINISH'
      #!/bin/bash
      cloud-init status --wait || true
      cloud-init clean --logs --seed --machine-id --configs network
      rm -f /etc/netplan/50-cloud-init.yaml /etc/ssh/ssh_host_*
      rm -f /var/log/ci-image-build.log
      fstrim -av
      echo '<2>CI-IMAGE-BUILD-OK' > /dev/kmsg
      systemctl poweroff
      FINISH
      chmod 0700 /root/finish.sh
      systemd-run --unit ci-image-finish --on-active=5 /root/finish.sh
# The build writes to a file, not the serial console: serial-getty hangs up other writers to
# ttyS0 when it starts. Result lines go through the kernel log at level 2 (critical): the
# guest prints only levels below 4 on the console.
runcmd:
  - [bash, -c, "/root/build.sh < /dev/null > /var/log/ci-image-build.log 2>&1 || { tail -n 40 /var/log/ci-image-build.log | while IFS= read -r l; do echo \"<2>build: ${l:0:300}\" > /dev/kmsg; done; echo \"<2>CI-IMAGE-BUILD-FAILED\" > /dev/kmsg; systemctl poweroff; }"]
USERDATA

port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work/seed" > "$work/seed.log" 2>&1 &
seed_pid=$!

qemu-img create -q -f qcow2 -F qcow2 -b "$cloud_image" "$work/disk.qcow2" 16G
qemu-system-x86_64 -name ci-image-build -nodefaults -display none \
  -machine q35,accel=kvm -cpu host -smp 2 -m 2048 \
  -drive "if=virtio,format=qcow2,file=$work/disk.qcow2" \
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
  -serial "file:$work/console.log" \
  -smbios "type=1,serial=ds=nocloud;s=http://10.0.2.2:$port/" &
qemu_pid=$!

deadline=$((SECONDS + 2400))
while kill -0 "$qemu_pid" 2>/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    cp "$work/console.log" "${output%.qcow2}.console.log"
    echo "the build VM did not finish in 40 minutes; console log kept in ${output%.qcow2}.console.log" >&2
    exit 1
  fi
  sleep 5
done
wait "$qemu_pid" || true
qemu_pid=""

if ! grep -q CI-IMAGE-BUILD-OK "$work/console.log"; then
  cp "$work/console.log" "${output%.qcow2}.console.log"
  echo "the build failed; full console log kept in ${output%.qcow2}.console.log" >&2
  exit 1
fi
qemu-img convert -O qcow2 "$work/disk.qcow2" "$output"
qemu-img info "$output"
