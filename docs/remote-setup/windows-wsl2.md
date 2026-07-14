# Setting Up SSH Access to a Windows + WSL2 Remote

`claude-remote` requires the remote machine's SSH server to land incoming
connections directly inside a Linux shell (see the design spec's "OS
support" decision and this project's README). On Windows, that means
running `sshd` *inside* WSL2 itself, not Windows' own OpenSSH Server —
Windows' `sshd` would need a `ForceCommand` wrapper to correctly proxy
remote commands into WSL2 (plain `ForceCommand wsl.exe` ignores the actual
command the SSH client sent and always opens an interactive shell instead,
which breaks `claude-remote`'s programmatic remote command execution).
Running `sshd` natively inside WSL2 avoids that fragility entirely and
behaves like a normal Linux SSH server.

## 1. Install OpenSSH server inside WSL2

In a WSL2 (Ubuntu) terminal:
```bash
sudo apt update
sudo apt install -y openssh-server
```

## 2. Enable systemd so sshd starts automatically with WSL2

Add to `/etc/wsl.conf` inside WSL2:
```ini
[boot]
systemd=true
```
Apply it from PowerShell on Windows:
```powershell
wsl --shutdown
```
Wait a few seconds, then reopen the WSL2 terminal. Then:
```bash
sudo systemctl enable ssh
sudo systemctl start ssh
```

## 3. Enable WSL2 mirrored networking (avoids manual port forwarding)

By default WSL2 runs behind NAT with its own internal IP that changes on
every restart, which would otherwise require `netsh interface portproxy`
rules kept in sync manually. Mirrored networking makes WSL2 share the
Windows host's own IP directly, so SSHing into the Windows machine's normal
IP reaches WSL2's `sshd` with no forwarding rules needed.

**Requirements:** Windows 11, WSL >= 2.0.0.

### 3.1 Check prerequisites

```powershell
wsl --version
```
Needs WSL version 2.0.0+. If the command isn't recognized or the version is
older:
```powershell
wsl --update
```
Confirm the Windows edition is 11 via Settings → System → About.

### 3.2 Create `.wslconfig`

This file lives on the **Windows side**, at `%UserProfile%\.wslconfig`
(it usually doesn't exist yet — create it fresh).
```powershell
notepad $env:USERPROFILE\.wslconfig
```
Contents:
```ini
[wsl2]
networkingMode=mirrored
```
Save and close.

### 3.3 Apply

```powershell
wsl --shutdown
```
Wait ~10 seconds, then reopen the WSL2 terminal.

### 3.4 Verify

Inside WSL2:
```bash
hostname -I
```
Compare against the Windows machine's IP from `ipconfig` (see step 5
below). If they match, mirrored mode is active. If not, mirrored mode
isn't working — check `wsl --version` again, or fall back to the NAT +
port-forwarding approach (see "Fallback" below).

## 4. Open the firewall

PowerShell (as Administrator):
```powershell
New-NetFirewallRule -DisplayName "WSL2 SSH" -Direction Inbound -LocalPort 22 -Protocol TCP -Action Allow
```

## 5. Find the machine's IP (for `config.yaml`'s `remote.host`)

On Windows, PowerShell or Command Prompt:
```
ipconfig
```
Use the **IPv4 Address** under the active adapter (Wi-Fi/Ethernet) — not
WSL2's own internal IP from `hostname -I`, unless mirrored mode is
confirmed active (step 3.4), in which case they're the same address.

## 6. Set up key-based login

From the Mac:
```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub <wsl-username>@<windows-ip>
```
(Generate a key first if you don't have one: `ssh-keygen -t ed25519`.)

## 7. Test

```bash
ssh <wsl-username>@<windows-ip>
```
Should land directly in the Ubuntu/WSL2 shell, with no password prompt and
without ever touching PowerShell.

## Fallback: mirrored networking not available

If step 3.4 doesn't work (older Windows 10, or WSL too old even after
`wsl --update`), the alternative is classic NAT mode with
`netsh interface portproxy` forwarding a Windows port to WSL2's internal
IP, plus a startup script to keep that forwarding rule in sync — WSL2's
internal IP changes on every restart, so the forwarding rule silently goes
stale otherwise. This wasn't needed for this project's own setup; ask for
a detailed walkthrough if it applies to your machine.
