# CI runners on romper

Orbit's CI can run on the owner's machine `romper` instead of GitHub's hosted runners. GitHub's included minutes ran out in November 2026, and hosted jobs cost money past them. Jobs on romper cost nothing per minute.

## How a job picks its runner

Every job in `.github/workflows/` says:

```yaml
runs-on: ${{ vars.CI_RUNNER || 'ubuntu-24.04' }}
```

- The repository variable `CI_RUNNER` set to `romper-linux` sends every job to romper.
- With the variable unset, jobs ask for GitHub's `ubuntu-24.04` runner again.

GitHub reads the variable when it queues a run. Changing it affects new runs, not running ones.

## What runs on romper

[runner-up](https://github.com/kunchenguid/runner-up) v0.1.12 runs there as the `ubuntu` user's systemd user service `runner-up`. It holds a runner scale set for `aduthekaddu/orbit` with the label `romper-linux`. For each job it boots a fresh KVM virtual machine (a "place"), starts GitHub's runner in it for that one job, and deletes the machine afterwards.

- The virtual machines run as a separate user, `ci` (uid 1500). It is in the `kvm` group only: no sudo, no Docker, no lxd.
- Each machine boots from a copy-on-write layer over the base image in `/var/lib/ci-images/`. The base image is Ubuntu 24.04 with Docker, Compose, Buildx, Google Chrome, Node.js 22, git, jq, build tools and a 4 GB swap file. CodeQL needs the system Node.js, as on GitHub's image. The job runs as user `runner` (uid 1001) with passwordless sudo and Docker access, like GitHub's `ubuntu-24.04` image.
- Jobs from forks' pull requests are refused (runner-up's fork guard, `allowForkPullRequests: false`).

## What keeps romper safe

romper is also the owner's workstation and runs production Orbit. A job runs code from this repository, from third-party actions and from Dependabot updates, so it is kept away from the host:

- **Firewall.** The nftables table `inet ci_guard` (`/etc/ci-guard.nft`, loaded at boot by `ci-guard.service`) lets the `ci` user reach the public internet and its own listeners only. QEMU's user networking makes each guest connection a socket of the QEMU process, which runs as `ci`, so the rules see guest traffic as `ci` traffic. Refused: every service on romper's loopback, private and public addresses, Docker networks, the tailnet, and Oracle's metadata service. Allowed on the host: DNS through `127.0.0.53`, the SSH port QEMU forwards for runner-up, and runner-up's cloud-init seed server.
- **Memory.** `user-1500.slice` has `MemoryMax=9G`, so CI never takes the last of romper's memory (romper has no swap). Every `ci` session starts through `/usr/local/libexec/ci-ssh-entry`, which sets `oom_score_adj` to 1000: if romper still runs out, the kernel stops a CI machine first.
- **Start order.** `runner-up.service` starts only when `/run/ci-guard.ok` exists, which `ci-guard.service` writes after it loads the firewall.
- **Image.** The base image is owned by root, so a job cannot change what later jobs boot.

What stays open:

- A job has the internet, like a hosted job. A bad dependency could send the job's checkout or its short-lived `GITHUB_TOKEN` out.
- A guest can open TCP connections to other `ci` listeners: another running job's SSH forward (it needs that job's own key) and seed server (it serves public data only).
- A guest resolves names through romper's resolver, so it can resolve tailnet names. It cannot connect to them.
- A job that escapes its virtual machine runs as `ci` and could change the runner-up agent in `/home/ci` for later jobs.

## Files on romper

| Path | What it is |
| --- | --- |
| `~/.config/runner-up/config.json` (user `ubuntu`) | runner-up's setup: repository, pool, machine, place sizes, pinned release |
| `~/.config/runner-up/gh/` | The `gh` sign-in for runner-up only (`GH_CONFIG_DIR`). It holds the fine-grained token. |
| `~/.config/runner-up/token.env` | The token's expiry date |
| `~/.config/systemd/user/runner-up.service` | The coordinator's unit ([copy](../scripts/ci-runner/runner-up.service)) |
| `~/.ssh/runner-up_ci_ed25519` | The coordinator's key for `ci@127.0.0.1` |
| `/home/ci/.ssh/authorized_keys` | That key, only from `127.0.0.1` and `::1`, forced through `ci-ssh-entry` |
| `/etc/ci-guard.nft`, `/etc/systemd/system/ci-guard.service` | The firewall ([copy](../scripts/ci-runner/ci-guard.nft), [unit](../scripts/ci-runner/ci-guard.service)) |
| `/etc/systemd/system/user-1500.slice.d/50-ci.conf` | The memory cap |
| `/usr/local/libexec/ci-ssh-entry` | The SSH entry ([copy](../scripts/ci-runner/ci-ssh-entry)) |
| `/var/lib/ci-images/` | The Ubuntu cloud image and the CI base image |

## Set up from scratch

This is how romper was set up on 2026-11-14. Check every download against its published checksum.

1. `sudo apt-get install --no-install-recommends qemu-system-x86 qemu-utils`
2. The `ci` user: `sudo useradd --uid 1500 --create-home --shell /bin/bash ci`, then `sudo usermod -aG kvm ci`. Install `scripts/ci-runner/ci-ssh-entry` as `/usr/local/libexec/ci-ssh-entry` (root, 0755) and the memory cap drop-in.
3. As `ubuntu`, make the key `~/.ssh/runner-up_ci_ed25519`. Put its public half in `/home/ci/.ssh/authorized_keys` as `restrict,from="127.0.0.1,::1",command="/usr/local/libexec/ci-ssh-entry" ssh-ed25519 ...`.
4. The firewall: replace `PUBLIC_IPV4` in `scripts/ci-runner/ci-guard.nft` with romper's public address, install it as `/etc/ci-guard.nft` and the unit as `/etc/systemd/system/ci-guard.service`, then `sudo systemctl enable --now ci-guard`. `/run/ci-guard.ok` must exist before any virtual machine boots.
5. Build the base image (see below).
6. Install runner-up and `gh` from their releases. Put `gh` in `~/.local/share/runner-up/gh/bin/`, off the `PATH`, so other programs on romper do not pick up the token. Run `scripts/ci-runner/runner-up-token-wizard.sh`.
7. Set up runner-up:

   ```bash
   export GH_CONFIG_DIR=~/.config/runner-up/gh
   runner-up init --repo aduthekaddu/orbit --pool romper-linux --gh ~/.local/share/runner-up/gh/bin/gh
   runner-up machine add romper --ssh "-i $HOME/.ssh/runner-up_ci_ed25519 -o IdentitiesOnly=yes ci@127.0.0.1" \
     --provider kvm --image /var/lib/ci-images/ci-noble-20261114b.qcow2 \
     --places 1 --place-cores 4 --place-memory 4096 --disk-gb 40 --room-cores 12 --room-memory 11800
   ```

   Add `release` with the version and the `linux-amd64` SHA-256 to `config.json`, then run `runner-up update` and `runner-up check-config`.
8. Install `scripts/ci-runner/runner-up.service` as `~/.config/systemd/user/runner-up.service`, then `systemctl --user enable --now runner-up`.

## Tasks

Run these on romper as `ubuntu` unless they say `sudo`. `runner-up` is `~/.local/bin/runner-up`.

### Check the runners

```bash
runner-up status
systemctl --user status runner-up
journalctl --user -u runner-up -n 50
```

### Roll back to GitHub's runners

Run this where `gh` is signed in as the repository owner, such as the owner's laptop. runner-up's token on romper cannot change variables.

```bash
gh variable delete CI_RUNNER --repo aduthekaddu/orbit
```

New runs then ask for `ubuntu-24.04`. They wait while the account has no minutes left. To switch back, run `gh variable set CI_RUNNER --body romper-linux --repo aduthekaddu/orbit`.

### Stop everything now

1. Cancel the runs in GitHub, or roll back as above.
2. `systemctl --user stop runner-up`
3. `sudo loginctl terminate-user ci` ends every CI virtual machine and runner-up agent.

### Rebuild the base image

Do it every month or so, for security updates and new Chrome and Docker versions.

1. Download Ubuntu's noble cloud image and check it against the signed `SHA256SUMS` (`gpgv --keyring /usr/share/keyrings/ubuntu-cloudimage-keyring.gpg SHA256SUMS.gpg SHA256SUMS`, then `sha256sum -c`). Install it read-only into `/var/lib/ci-images/`.
2. As `ci`, run [`scripts/ci-runner/build-base-image.sh`](../scripts/ci-runner/build-base-image.sh) `CLOUD_IMAGE OUTPUT.qcow2`. It needs the firewall loaded, takes about 10 minutes, and keeps the VM's console log next to `OUTPUT` when it fails.
3. `sudo install -m 0444 -o root -g root OUTPUT.qcow2 /var/lib/ci-images/`
4. Point the place's `image` in `config.json` at the new file. runner-up applies the change to the next job. Delete the old image once no job uses it.

### Update runner-up

runner-up pins GitHub's runner version. GitHub may stop sending jobs to runner 2.338.1 around **2026-12-28** ([runner-up#67](https://github.com/kunchenguid/runner-up/issues/67)), so update runner-up before then.

1. Read the new release's notes and its `checksums.txt`.
2. In `config.json`, set `release.version` and `release.sha256.linux-amd64` to the new version and its archive's SHA-256.
3. The running coordinator downloads it, checks the SHA-256, and replaces itself. `runner-up status` and `journalctl --user -u runner-up` show the result.

### Renew the token

The token's expiry date is in `~/.config/runner-up/token.env`. The first token expires on **2026-12-14**. After it, runner-up gets 401 errors and no jobs ([runner-up#55](https://github.com/kunchenguid/runner-up/issues/55)). Before it, run [`scripts/ci-runner/runner-up-token-wizard.sh`](../scripts/ci-runner/runner-up-token-wizard.sh) on romper, then `systemctl --user restart runner-up`.

### Change the number or size of places

Measure first: run `scripts/ci-runner/ci-sample.sh > samples.log` on romper while CI runs. It prints the host's available memory, the `ci` slice's memory, and each virtual machine's memory and CPU every 5 seconds. runner-up's own `usage` readings do not cover KVM places.

Then edit the machine's `roomCores`, `roomMemoryMB` and its places in `config.json`, and run `runner-up check-config`. A virtual machine takes its place's memory plus about 50 MB from romper once the guest has used all of it. Keep the places' total under the 9 GB cap.

### When romper's public IP changes

Update the `public4` set in `/etc/ci-guard.nft`, then `sudo systemctl restart ci-guard`.
