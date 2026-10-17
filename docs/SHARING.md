# Sharing the site with people outside your home

The site is built for a household: profiles open with a tap, anyone on the
network can add one, and every film is offered in the best quality the
connection at home carries. People outside your home need a different door:
one only the people you choose can open, behind a connection that is much
narrower than your own network. The safest way is a **second instance** just
for them, with its own profiles and history, reached through a tunnel, and
joined by **invite links**. Your own instance stays exactly as it is.

## Invite links

Settings → Server → Profiles:

- **Anyone can add a profile**: off. Nobody can sign up without an invite.
- **Show profiles on sign-in**: off. Visitors type their name and PIN instead
  of seeing everyone's profile.
- **New profiles need a PIN**: on. A profile without one opens for anyone who
  knows its name.
- **Invite links**: make a link for each tester, good for one person or a
  few, for a day, a week, a month or until you switch it off. Send them
  `https://your-address/join/abcd-efgh-jkmn`; it opens the sign-up form, and
  the tester picks a name, a picture and a PIN.

An invite link is checked when the form opens and used when the profile is
made. A used-up, expired or switched-off link says so. Testers cannot see or
make invites; the admin sees each one's uses and state. Five wrong PINs lock
a profile for 15 minutes, doubling with every further round, up to a day.

Testers can tell you what went wrong. **Report a problem** in the player's
settings menu sends a note with the film and the moment it happened, and
**Send feedback** in Settings sends one that is not about a film. You read
them in Settings → Server → Feedback from viewers, and delete them there.

## A separate instance for testers

Run a second copy of the site beside your own, with its own `.env`, its own
`db/` and its own port, bound to `127.0.0.1` so it is not on your network at
all. Its first profile becomes its admin: create yours on the machine itself
(`http://127.0.0.1:<port>`) before the tunnel is opened. In its `.env`:

```
# A copy for people outside the home
PUBLIC_INSTANCE=1

# What the tunnel carries (measure it, see below)
CAPACITY_UPLINK_MBPS=20
PLAYBACK_MAX_HEIGHT=1080
PLAYBACK_MAX_MBPS=10

# Its own share of the machine, smaller than yours
AC_MEMORY_LIMIT=6g
VOD_MAX_RUNS=6

# Its own dashboard (docs/HUB.md)
HUB_KEY=...
HUB_LABEL=Testers
```

`PUBLIC_INSTANCE=1` makes it a server for people outside the home:

- **The door starts locked**: sign-ups closed, no profile list, a PIN on
  every profile (each still a switch in Settings, and
  `SIGNUPS_OPEN_DEFAULT`, `PROFILE_PICKER_DEFAULT` and `REQUIRE_PIN_DEFAULT`
  set other starting points).
- **Every viewer counts as outside the home**: the capacity gate
  (docs/CAPACITY.md) weighs each stream against `CAPACITY_UPLINK_MBPS`, and
  someone who would not fit waits in the queue.
- **Debrid links never reach a browser**. Real-Debrid and AllDebrid allow
  their accounts to be used from one address, your home's. On a public
  instance every debrid file plays through this server, remuxed; the player
  is sent a stand-in in place of the link, and asks the server for the file
  by its id. Files only a browser could play itself (MP4) are not offered.
- **Downloads are off**: a whole file through the tunnel would take all of it
  for an hour, with no seat in the capacity gate to account for it.

`PLAYBACK_MAX_HEIGHT` and `PLAYBACK_MAX_MBPS` hold the picture to what the
tunnel carries: files taller or heavier (by their average bitrate) than the
caps are not offered, and a cap below 4K means no 4K is looked for. An
adaptive stream is kept when its lowest rendition fits; its player climbs
only as high as the connection allows. Any server can use the caps, public
or not.

Give it a CPU limit and a lower CPU priority than your own instance in its
`docker-compose.override.yml` (for example `cpus: 3` and `cpu_shares: 512`),
so testers never slow your own viewing down.

## Tailscale Funnel

[Funnel](https://tailscale.com/docs/features/tailscale-funnel) gives a
machine on your tailnet a public HTTPS address without opening a port on
your router:

```bash
sudo tailscale funnel --bg --https=443 http://127.0.0.1:<the instance's port>
```

The address is `https://<machine>.<tailnet>.ts.net`. Funnel sets
`X-Forwarded-For` to the visitor's own address (replacing whatever the
visitor sent), so the sign-in lockouts and rate limits see each visitor.
Three things to know:

- **Funnel's bandwidth is limited** by Tailscale, and the limit is not
  published. On the reference server it measured about 20 Mbit/s in total,
  the same over one connection or four: two or three 1080p streams at once.
  Measure yours (serve a large file on a spare Funnel port such as 10000 and
  time a download through the public address) and set
  `CAPACITY_UPLINK_MBPS` to it; the gate keeps its own headroom.
- **The public name can take a while to appear**, and on some tailnets it
  does not appear at all until the Funnel permission is removed and added
  back in the tailnet's policy file.
- **Funnel only listens on ports 443, 8443 and 10000.**

Do not use a tunnel whose terms forbid video, such as Cloudflare's free tunnel.
Your debrid services still see every download coming from your home address,
which is what their rules ask; their accounts remain for personal use.
