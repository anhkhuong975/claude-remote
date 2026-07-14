# Setting Up SSH Access to a Linux Remote

Most Linux distributions either ship with `sshd` already running or make it
a one-line install — much simpler than the Windows+WSL2 case (no NAT
traversal, no networking-mode configuration, no command-forwarding wrapper
needed: a native Linux machine's SSH server already behaves exactly the way
`claude-remote`'s `ssh.ts`/`setup.ts` assume).

## 1. Install OpenSSH server (if not already present)

```bash
sudo apt update
sudo apt install -y openssh-server
```

## 2. Enable and start sshd

```bash
sudo systemctl enable --now ssh
```

## 3. Open the firewall (if one is active)

If `ufw` is enabled:
```bash
sudo ufw allow ssh
```

## 4. Find the machine's IP (for `config.yaml`'s `remote.host`)

```bash
hostname -I
```
Or:
```bash
ip addr show
```
Use the IP on the active network interface (e.g. `eth0`/`wlan0`), not
`127.0.0.1`.

## 5. Set up key-based login

From the Mac:
```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub <user>@<linux-ip>
```
(Generate a key first if you don't have one: `ssh-keygen -t ed25519`.)

## 6. Test

```bash
ssh <user>@<linux-ip>
```
Should land directly in a shell, with no password prompt.
