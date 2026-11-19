# CI runners on romper

The decision behind this setup is [ADR 0001](adr/0001-ci-on-romper.md). [ADR 0003](adr/0003-freestyle-overflow.md) adds Freestyle VMs for when GitHub's allowance is used up.

Orbit's CI can run on the owner's machine `romper` instead of GitHub's hosted runners. GitHub's included minutes ran out in November 2026, and hosted jobs cost money past them. Jobs on romper cost nothing per minute.

## How a job picks its runner

Every job in `.github/workflows/` says:

```yaml
runs-on: ${{ vars.CI_RUNNER || 'ubuntu-24.04' }}
```

- The repository variable `CI_RUNNER` set to `romper-linux` sends every job to romper.
- `CI_RUNNER` set to `freestyle-linux` sends every job to a fresh Freestyle VM. See [Freestyle overflow](#freestyle-overflow).
- With the variable unset, jobs ask for GitHub's `ubuntu-24.04` runner again.

GitHub reads the variable when it queues a run. Changing it affects new runs, not running ones.

## Freestyle overflow

When GitHub's allowance is used up and romper is busy, Orbit's CI can run on short-lived Freestyle VMs instead. The order of use is GitHub's runners, then Freestyle, then romper. The decision is [ADR 0003](adr/0003-freestyle-overflow.md).

[freestyle-runners](https://github.com/aduthekaddu/freestyle-runners) runs on romper as the `ubuntu` user's systemd user service `freestyle-runners`. It watches Orbit for queued jobs with the label `freestyle-linux`. For each job it starts a fresh Freestyle VM with 4 vCPU and 8 GiB, starts GitHub's runner in it for that one job, and deletes the VM afterwards. The VMs run on Freestyle's machines, so the romper safeguards below do not apply to them. Each VM can reach public addresses and accepts no inbound connections. Jobs from forks' pull requests are refused, as on romper. To check or stop the service, see [Running the service](https://github.com/aduthekaddu/freestyle-runners/blob/main/docs/service.md).

### Switch to Freestyle and back

Run these where `gh` is signed in as the repository owner. To send new runs to Freestyle:

```bash
gh variable set CI_RUNNER --body freestyle-linux --repo aduthekaddu/orbit
```

To send new runs back to romper:

```bash
gh variable set CI_RUNNER --body romper-linux --repo aduthekaddu/orbit
```

GitHub reads the variable when it queues a run, so a switch changes only the runs queued after it. When GitHub's allowance is back, delete the variable as in [Roll back to GitHub's runners](#roll-back-to-githubs-runners).

### What the service does at 85% of the free plan

Freestyle's API reports no usage, so the service keeps its own estimate. When the estimate reaches 85% of the free plan, 170 of its 200 vCPU-hours a month, the service stops creating VMs. If Orbit's `CI_RUNNER` is `freestyle-linux`, the service sets it to `romper-linux`, so new runs go to romper. It also opens an issue with the label `budget-limit` in [aduthekaddu/freestyle-runners](https://github.com/aduthekaddu/freestyle-runners/issues).

The free allowance resets on the 13th of each month at 00:16 IST, which is 18:46 UTC on the 12th. After the reset, the service sets `CI_RUNNER` back to `freestyle-linux` and closes the issue.

### Cost and capacity

One round is the 14 jobs that one push to a pull request starts. A full Orbit round ran on Freestyle on 2026-11-19 ([proof](https://github.com/aduthekaddu/orbit/pull/94#issuecomment-7021145263)). The table gives its cost from the service's budget ledger, and the rounds a month that cost allows before the 85% switch.

| Cost per round | vCPU-hours | Rounds before the 85% switch |
| --- | --- | --- |
| Measured, with one re-run of the flaky `End to end (sandbox)` job | 5.9 | 28 |
| Measured, without the re-run | 5.2 | 32 |
| Estimated, with Freestyle creating VMs in about 13 s | 3.5 | 48 |

At the measured cost, the free plan covers about 28 to 32 rounds a month. The estimate is the round's job time plus about 77 s of overhead for each of the 14 VMs, at the create time Freestyle reached late in the proof. A VM has 2 GiB per vCPU, so the plan's 400 GiB-hours allow the same number of rounds.

The `End to end (sandbox)` job failed once in the proof, in its `sandbox-stop-output` scenario. That scenario fails the same way on romper, and the job passed when re-run.

### Speed

The proof round took 40 minutes (2,415 s) on Freestyle, against 28 minutes (1,657 s) for the last green round on romper. VM creation set that time, not the jobs. The Docker image job took 374 s on Freestyle against 616 s on romper. That day the service created VMs one after another, and each create took 35 s to 5 minutes. Four creates failed, and three failures in a row paused creation for 10 minutes. [freestyle-runners#12](https://github.com/aduthekaddu/freestyle-runners/issues/12) and [freestyle-runners#13](https://github.com/aduthekaddu/freestyle-runners/issues/13) track the two problems.

## What runs on romper

[runner-up](https://github.com/kunchenguid/runner-up) v0.1.12 runs there as the `ubuntu` user's systemd user service `runner-up`. It holds a runner scale set for `aduthekaddu/orbit` with the label `romper-linux`. For each job it boots a fresh KVM virtual machine (a "place"), starts GitHub's runner in it for that one job, and deletes the machine afterwards.

- The virtual machines run as a separate user, `ci` (uid 1500). It is in the `kvm` group only: no sudo, no Docker, no lxd.
- Each machine boots from a copy-on-write layer over the base image in `/var/lib/ci-images/`. The base image is Ubuntu 24.04 with Docker, Compose, Buildx, Google Chrome, Node.js 22, git, jq, build tools and a 4 GB swap file. CodeQL needs the system Node.js, as on GitHub's image. The job runs as user `runner` (uid 1001) with passwordless sudo and Docker access, like GitHub's `ubuntu-24.04` image.
- Jobs from forks' pull requests are refused (runner-up's fork guard, `allowForkPullRequests: false`): they fail as soon as they start. To run CI on a fork's change, push its branch to this repository and open the pull request from there.
- Each machine pulls its Docker images afresh, anonymously, from romper's one public IP. Docker Hub allows that IP 100 pulls an hour (measured 2026-11-14). A CI and Security run pulls about 10, and two places finish at most a few runs an hour, so this stays under the limit. If jobs start failing with HTTP 429 from Docker Hub, add `{"registry-mirrors": ["https://mirror.gcr.io"]}` to `/etc/docker/daemon.json` in the image build. Google's mirror served this repository's pinned images.

## What keeps romper safe

romper is also the owner's workstation and runs production Orbit. A job runs code from this repository, from third-party actions and from Dependabot updates, so it is kept away from the host:

- **Firewall.** The nftables table `inet ci_guard` (`/etc/ci-guard.nft`, loaded at boot by `ci-guard.service`) lets the `ci` user reach the public internet and its own listeners only. QEMU's user networking makes each guest connection a socket of the QEMU process, which runs as `ci`, so the rules see guest traffic as `ci` traffic. Refused: every service on romper's loopback, private and public addresses, including its DNS resolver, plus Docker networks, the tailnet and Oracle's metadata service. Allowed on the host: the SSH port QEMU forwards for runner-up and runner-up's cloud-init seed server. TCP to romper's ports below 32768 gets a reset before the service sees a packet. Other local TCP is limited to 5 new connections a second and completes only when a `ci` socket answers. Jobs resolve names through public DNS servers (1.1.1.1, 9.9.9.9, 8.8.8.8), set in the image.
- **Memory.** `user-1500.slice` has `MemoryMax=9G`, so CI never takes the last of romper's memory (romper has no swap). Every `ci` session starts through `/usr/local/libexec/ci-ssh-entry`, which sets `oom_score_adj` to 1000: if romper still runs out, the kernel stops a CI machine first.
- **Firewall check.** Every `ci` session starts through `/usr/local/libexec/ci-ssh-entry`, which first connects to romper's SSH port as `ci`. With the firewall loaded that gets a reset; without it, sshd answers, and the entry refuses the session. So no job starts while the firewall is missing. `ci-guard.service` loads it at boot, before user sessions.
- **Time.** `maxJobSeconds` is 3600. A job's serial console goes to a log on romper with no size limit. A job with sudo wrote to it at about 39 KB a second (measured), so an hour stays under about 140 MB, and runner-up deletes the virtual machine's folder, log included, when the job ends.
- **Image.** The base image is owned by root, so a job cannot change what later jobs boot.

What stays open:

- A job has the internet, like a hosted job. A bad dependency could send the job's checkout or its short-lived `GITHUB_TOKEN` out.
- A guest can open TCP connections to other `ci` listeners: another running job's SSH forward (it needs that job's own key) and seed server (it serves public data only).
- A guest can still tell an open local port from a closed one in the ephemeral range (32768 and up) by timing, and can hold a few half-open connections there (at most 5 new ones a second, with SYN cookies on). It cannot complete a connection to any of them.
- A job that loses its firewall mid-run keeps running until it ends. Only new sessions are refused.
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
| `/etc/systemd/system/user-1500.slice.d/50-ci.conf` | The memory cap ([copy](../scripts/ci-runner/50-ci.conf)) |
| `/usr/local/libexec/ci-ssh-entry` | The SSH entry ([copy](../scripts/ci-runner/ci-ssh-entry)) |
| `/var/lib/ci-images/` | The Ubuntu cloud image and the CI base image |

## Set up from scratch

This is how romper was set up on 2026-11-14. Check every download against its published checksum.

1. `sudo apt-get install --no-install-recommends qemu-system-x86 qemu-utils`
2. The `ci` user: `sudo useradd --uid 1500 --create-home --shell /bin/bash ci`, then `sudo usermod -aG kvm ci`. Install `scripts/ci-runner/ci-ssh-entry` as `/usr/local/libexec/ci-ssh-entry` (root, 0755) and `scripts/ci-runner/50-ci.conf` as `/etc/systemd/system/user-1500.slice.d/50-ci.conf`, then `sudo systemctl daemon-reload`.
3. As `ubuntu`, make the key `~/.ssh/runner-up_ci_ed25519`. Put its public half in `/home/ci/.ssh/authorized_keys` as `restrict,from="127.0.0.1,::1",command="/usr/local/libexec/ci-ssh-entry" ssh-ed25519 ...`.
4. The firewall: replace `PUBLIC_IPV4` in `scripts/ci-runner/ci-guard.nft` with romper's public address, install it as `/etc/ci-guard.nft` and the unit as `/etc/systemd/system/ci-guard.service`, then `sudo systemctl enable --now ci-guard`. Load it before any virtual machine boots: `ssh -i ~/.ssh/runner-up_ci_ed25519 ci@127.0.0.1 true` succeeds only once it is.
5. Build the base image (see below).
6. Install runner-up from its release as `~/.local/bin/runner-up`. Install `gh` from its release in `~/.local/share/runner-up/gh/bin/`, off the `PATH`, so other programs on romper do not pick up the token. Run `scripts/ci-runner/runner-up-token-wizard.sh`.
7. Set up runner-up:

   ```bash
   export GH_CONFIG_DIR=~/.config/runner-up/gh
   runner-up init --repo aduthekaddu/orbit --pool romper-linux --gh ~/.local/share/runner-up/gh/bin/gh
   runner-up machine add romper --ssh "-i $HOME/.ssh/runner-up_ci_ed25519 -o IdentitiesOnly=yes ci@127.0.0.1" \
     --provider kvm --image /var/lib/ci-images/ci-noble-20261114c.qcow2 \
     --places 2 --place-cores 4 --place-memory 4096 --disk-gb 40 --room-cores 8 --room-memory 7786
   ```

   `machine add` copies runner-up to `/home/ci/.local/bin/`. Add `release` with the version and the `linux-amd64` SHA-256, and `"maxJobSeconds": 3600`, to `config.json`, then run `runner-up update` and `runner-up check-config`.
8. Install `scripts/ci-runner/runner-up.service` as `~/.config/systemd/user/runner-up.service`, then `systemctl --user enable --now runner-up`. `sudo loginctl enable-linger ubuntu` keeps it running with nobody logged in (already on for romper).

## Add a repository

Any private repository of the account can use the same pool. For each one:

1. **Token.** The owner adds the repository to the fine-grained token "runner-up on romper" (Settings, Developer settings, Fine-grained tokens, Edit, Repository access). The token value does not change.
2. **runner-up.** Add `owner/name` to `github.repos` in `~/.config/runner-up/config.json` and run `runner-up check-config`. The running coordinator opens a scale set for it (`journalctl --user -u runner-up` logs `scale set session open`). Do not rerun `runner-up init`: it rewrites the setup.
3. **Tools.** Read every workflow. List what a job uses that GitHub's image has and this image lacks (see the base image above). Install it in the job, or add it to `build-base-image.sh` and rebuild. Setup actions such as `setup-node`, `setup-python`, `setup-uv` and `pnpm/action-setup` work as they are. Service containers work, because the image has Docker.
4. **Workflows.** Change each `runs-on: LABEL` to `runs-on: ${{ vars.CI_RUNNER || 'LABEL' }}`, keeping each job's own label as the fallback.
5. **Variable first.** `gh variable set CI_RUNNER --body romper-linux --repo owner/name`, before the pull request opens, since GitHub reads it when it queues a run.
6. **Proof.** Open the pull request. Every job must show a `runner-up-romper-*` runner and pass, with the same result per job as the repository's last green hosted run of the same event type. Rollback is `gh variable delete CI_RUNNER --repo owner/name`.

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

New runs then ask for `ubuntu-24.04`. While the account has no minutes left they fail at once with a spending-limit error, without using minutes. To switch back, run `gh variable set CI_RUNNER --body romper-linux --repo aduthekaddu/orbit`.

### Stop everything now

1. Cancel the runs in GitHub, or roll back as above.
2. `systemctl --user stop runner-up`
3. `sudo loginctl terminate-user ci` ends every CI virtual machine and runner-up agent.

### Rebuild the base image

Do it every month or so, for security updates and new Chrome and Docker versions.

1. Download Ubuntu's noble cloud image and check it against the signed `SHA256SUMS` (`gpgv --keyring /usr/share/keyrings/ubuntu-cloudimage-keyring.gpg SHA256SUMS.gpg SHA256SUMS`, then `sha256sum -c`). Install it read-only into `/var/lib/ci-images/`.
2. Run [`scripts/ci-runner/build-base-image.sh`](../scripts/ci-runner/build-base-image.sh) as `ci` through the coordinator's key, so it runs under the memory cap and the firewall check:

   ```bash
   ssh -i ~/.ssh/runner-up_ci_ed25519 ci@127.0.0.1 'mkdir -p ~/image-build && cat > ~/image-build/build.sh && cd ~/image-build && bash build.sh /var/lib/ci-images/CLOUD_IMAGE ~/image-build/ci-noble-DATE.qcow2' < scripts/ci-runner/build-base-image.sh
   ```

   It takes about 5 minutes. Its build VM uses 2 cores and 2 GB, which does not fit under the memory cap beside two running jobs, so build while no job runs. When it fails it keeps the VM's console log next to the output.
3. `sudo install -m 0444 -o root -g root OUTPUT.qcow2 /var/lib/ci-images/`
4. Point the place's `image` in `config.json` at the new file. runner-up applies the change to the next job. Delete the old image once no job uses it.

### Update runner-up

runner-up pins GitHub's runner version. GitHub may stop sending jobs to runner 2.338.1 around **2026-12-28** ([runner-up#67](https://github.com/kunchenguid/runner-up/issues/67)), so update runner-up before then.

1. Read the new release's notes and its `checksums.txt`, and find the runner version and SHA-256 it pins.
2. If that runner version is new, give the agent its archive first. The firewall keeps `ci` off romper's DNS resolver, so the agent cannot download it itself. As `ubuntu`, download `actions-runner-linux-x64-VERSION.tar.gz` from GitHub's runner release, check its SHA-256, then copy it in under a temporary name and move it into place, so a job never reads half a file:

   ```bash
   ssh -i ~/.ssh/runner-up_ci_ed25519 ci@127.0.0.1 'f=~/.local/state/runner-up/agent/cache/actions-runner-linux-x64-VERSION.tar.gz; cat > "$f.part" && mv "$f.part" "$f"' < actions-runner-linux-x64-VERSION.tar.gz
   ```

   The agent checks the archive's SHA-256 on every use, so a wrong file fails the job instead of running.
3. In `config.json`, set `release.version` and `release.sha256.linux-amd64` to the new version and its archive's SHA-256.
4. The running coordinator downloads it, checks the SHA-256, and replaces itself. `runner-up status` and `journalctl --user -u runner-up` show the result.

### Renew the token

The token's expiry date is in `~/.config/runner-up/token.env`. The first token expires on **2026-12-14**. After it, runner-up gets 401 errors and no jobs ([runner-up#55](https://github.com/kunchenguid/runner-up/issues/55)). Before it, run [`scripts/ci-runner/runner-up-token-wizard.sh`](../scripts/ci-runner/runner-up-token-wizard.sh) on romper, then `systemctl --user restart runner-up`.

### Change the number or size of places

Measure first: run `scripts/ci-runner/ci-sample.sh > samples.log` on romper while CI runs. It prints the host's available memory, the `ci` slice's memory, and each virtual machine's memory and CPU every 5 seconds. runner-up's own `usage` readings do not cover KVM places.

Then edit the machine's `roomCores`, `roomMemoryMB` and its places in `config.json`, and run `runner-up check-config`. A virtual machine takes its place's memory plus about 50 MB from romper once the guest has used all of it. Keep runner-up's budget, `memoryMB - roomMemoryMB`, at 8192 MB or less, so the places always fit under the 9 GB cap. romper runs two places of 4 cores and 4096 MB, with `roomCores` 8 and `roomMemoryMB` 7786.

### When romper's public IP changes

Update the `public4` set in `/etc/ci-guard.nft`, then `sudo systemctl restart ci-guard`.
