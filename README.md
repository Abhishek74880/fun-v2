# Fun time

Watch a video together, in sync, with chat plus voice and video calling. No accounts, no dependencies, no ads.

## Easiest: put it online once (works for friends on any network)
1. Create a free account at github.com, make a new repository, and drag every file from this folder into it ("uploading an existing file").
2. Create a free account at render.com, choose New > Blueprint, pick that repository, and press Apply.
3. In a few minutes you get a permanent address like https://fun-time-xxxx.onrender.com. Open it on any phone or computer, create a room, upload, and send the invite link.

Free hosting sleeps after ~15 min idle (the first visit then takes ~30 s to wake) and has limited disk. Uploads are capped at 3 GB (MAX_MB=3072); if a very large upload fails on the free plan, try a smaller file or a paid instance with more disk.

## Or run it on your own computer
Install Node.js (LTS) from nodejs.org, then double-click `start-windows.bat` or `start-mac.command` (or run `node server.js`).
The terminal prints a localhost link and a same-Wi-Fi link. Friends on other networks need the hosted option above.

Options: `PORT=8080 MAX_MB=6144 node server.js`

## Voice and video calls
Press **Join call** in a room (both people need to join). Camera and mic go directly between browsers (WebRTC); the server only relays setup messages.
- Calls need HTTPS, which the hosted option gives you. On localhost it works too, but over a plain http Wi-Fi address browsers block the camera.
- Use headphones, otherwise the movie sound leaks into the microphone and your friend hears an echo.
- Most connections work out of the box. If a call never connects (strict office or mobile networks), add a free TURN relay such as Metered's, then set the environment variables `TURN_URL`, `TURN_USER` and `TURN_PASS` on your host.

## Ludo
Press **🎲 Ludo** in a room. Everyone who wants to play picks a funny face for their tokens and presses **Join game**; then anyone presses **Start**. 2 players sit opposite each other, 3 or 4 fill the other corners. Dice are rolled on the server, so nobody can cheat. Rules: you need a 6 to leave the yard, 6 / a capture / reaching home gives another roll, three 6s in a row loses the turn, stars and coloured start squares are safe, and you need the exact number to reach home. When a token is captured every browser plays a sound and speaks the capture line (editable in the Ludo panel); the winner is announced with confetti. The voice is your browser's built-in text-to-speech, so it sounds best if your device has a Hindi voice installed.

## Ending a room
The creator sees an **End room** button. It disconnects everyone, deletes the video and closes the invite link.

## Who's watching and removing people
The **Watching** panel lists everyone in the room by name (change yours in the box above the chat). Only the room creator's browser sees a **Remove** button next to each guest. A removed person is disconnected, dropped from the call, and blocked from chat and the video until they get a new browser tab. If you want to lock someone out for good, create a new room and share the new link only with people you trust.

## Security notes
Invite links are 96-bit random IDs, only the creator's browser holds the upload key, and rooms and videos are deleted after 6 idle hours or on restart.
