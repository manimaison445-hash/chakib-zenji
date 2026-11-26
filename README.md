# Chakib Zenji 2 : Railway folder

This one folder is the whole online setup:

- `public/` is the game (open it in a browser, nothing to install).
- `server.js` is a small server that (1) serves the game and (2) relays the online lobbies, so players can join each other with a code or a link.
- `Dockerfile`, `package.json`, `railway.json` tell Railway how to run it.

You do not need to change anything inside.

## 1. Put the folder on GitHub

GitHub's website accepts 100 files per upload, and this folder has about 120, so upload twice.
No file is bigger than 3 MB, so the 25 MB limit is not a problem.

1. On github.com, create a new repository (any name, for example `chakib-zenji`).
2. Click "uploading an existing file".
3. Upload 1: drag everything from this folder EXCEPT the folder `public/tex`
   (so: `Dockerfile`, `package.json`, `server.js`, `railway.json`, `README.md`, the `test` folder, and the `public` folder without `tex` inside it). Click "Commit changes".
4. Upload 2: click "Add file" > "Upload files", open the `public` folder on your computer, and drag the `tex` folder into the page. Commit again.
5. In the repository you must see `Dockerfile`, `server.js`, `package.json` at the top, and `public/tex` with 71 files inside.
   (Files that start with a dot, like `.gitignore`, are optional. If they do not upload, it is fine.)

## 2. Deploy on Railway

1. Go to railway.com and log in with GitHub.
2. New Project > Deploy from GitHub repo > choose your repository.
3. Railway builds it with the `Dockerfile`. Wait until the deploy is green.
4. Open the service > Settings > Networking > Generate Domain. You get a link like `something.up.railway.app`.
5. Settings > Region: choose **EU West (Amsterdam)**. It is the only European region Railway has.
6. Open `https://your-domain/health`. You must see `{"ok":true,...}`.
7. Open `https://your-domain/`, then Play > Multiplayer > Create a lobby. Send the invite link to a friend.

You do not need to set any variable. Optional ones:

| Variable | What it does |
|---|---|
| `ALLOWED_ORIGINS` | Other sites allowed to use the relay, separated by commas (only if you host the game page somewhere else). |
| `MAX_ROOMS` | Maximum lobbies at once (default 2000). |

## 3. What to know about the free plan

According to Railway's docs: a new account gets a 30-day trial with $5 of credit, no card needed, and you can choose the region during that trial.
After the trial, the Free plan gives $1 per month, services sleep when idle, and the region choice is not available.
For a lasting server in Europe you need the Hobby plan ($5 per month, card needed). Check railway.com/pricing for the current numbers.

## 4. How the online play works

- The game first tries a direct connection between players (WebRTC, through PeerJS). If that is blocked, it uses this relay.
- The relay only passes messages. The match itself runs in the browser of the player who created the lobby (the host). If the host leaves, the lobby closes after about 60 seconds.
- There is a checkbox "Go through the relay directly" in the Multiplayer screen for networks that block direct connections.
- Up to 8 players per lobby, as in the game.

## 5. What is not included

- No accounts, no friends list, no leaderboard and no public lobby list. Those belonged to the original author's private server, which is not part of the open-source files, so there is no database to connect.
- The Steam Deck installer is not included.

## 6. Check that the server works (optional)

On your computer, with Node 20 or newer: `npm install` then `npm test`.

## Credits

See `public/credits.html` and `public/LICENSE.txt`.
