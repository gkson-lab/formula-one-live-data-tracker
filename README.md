# Race Watch

A live Formula 1 race companion that runs on your own computer. Keep it open next to the TV during a Grand Prix.

![Race Watch during a safety car](docs/live.png)

## What it does

- **Timing tower**: positions, places gained or lost, interval, gap to the leader, tyres, and last lap (purple for fastest, green for personal best).
- **Track status band**: green, yellow, double yellow, red flag, safety car and VSC, updated live.
- **Event bars**: flags, safety cars, penalties, overtakes, pit stops and team radio slide down the right edge of the screen, with the cause when race control gives one. Red flags and safety cars stay until cleared.
- **Race start**: a five-light start sequence with a reaction-time game.
- **Track map**: real circuit outlines for the current calendar, with sector flags.
- **Team radio**: play the clips, and turn them into text with a speech model that runs in your browser.
- **TV delay**: line the data up with your broadcast, down to the second.
- **Relay panel**: see the relay's status and live log from inside the app.
- **Test mode**: trigger every event yourself, or run a simulated race.

![Test mode](docs/test-mode.png)

## Getting started (Windows)

1. Install [Node.js](https://nodejs.org) (the LTS version).
2. Download this project: click **Code**, then **Download ZIP**, and unzip it.
3. Double-click **Start Race Watch.bat**. The first run installs what it needs, then the app opens in your browser at http://localhost:3000.
4. Keep the black relay window open during the race. Close it to stop.

## Getting started (Mac or Linux)

```bash
npm install
npm start
```

Then open http://localhost:3000 if it does not open on its own.

## How it works

`f1-relay.js` is a small Node.js program that connects to Formula 1's public live timing feed and passes the data to the app (`f1-race-watch.html`), which it serves at http://localhost:3000. A browser cannot connect to the feed directly, which is why the relay is needed. No account or API key is required.

![Relay panel](docs/relay-panel.png)

The app can also read past sessions from [OpenF1](https://openf1.org) (free) or live sessions with a paid OpenF1 account. Choose the source in Settings.

## Disclaimer

This is an unofficial fan project. It is not associated in any way with the Formula 1 companies or the FIA. F1, FORMULA ONE, FORMULA 1, FIA FORMULA ONE WORLD CHAMPIONSHIP, GRAND PRIX and related marks are trade marks of Formula One Licensing B.V. Timing data belongs to its owners and is shown for personal use only.

The screenshots above use simulated data.

## License

[MIT](LICENSE)
