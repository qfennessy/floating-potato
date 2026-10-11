# Venus Balloon Navigator: 3-minute pitch

Created 2026-10-11 · Last edited 2026-10-11

Demo: https://venus-balloon-navigator.vercel.app (landing) → "Watch the race" → World 6.
Before you start: open `sim.html?world=6` in a second tab, paused at day 0, Sound on, Director on, Speed "fast".

## 0:00–0:25 · The problem (landing page)

> Venus is the worst place in the solar system to land. The ground is hot enough to melt lead, and landers die within hours.
> But 55 km up, inside the clouds, it's about as warm as Earth. A balloon can live there. Two did, in 1985, for two days.
> The catch: a balloon can't steer. The wind carries it all the way around the planet every four days.

## 0:25–0:55 · The trick (switch to the sim tab; point at the wind panel)

> It can't steer, but it can go up or down, and every height has a different wind.
> *(point at the panel)* Up high it's fast and pushes you toward the pole. Down low it's slower and pushes you toward the equator.
> So picking a height picks your speed and your direction. That's the only steering there is, and it's what our pilots have to master.

## 0:55–2:05 · The race (press Play; World 6)

- **Deployment plays:** "Our capsule drops seven balloons into the clouds."
- **Click the "ER 2" score chip.** "We're following Google's Gemini Robotics-ER 2. Every two days it looks at this map and decides where to go."
- **Day ~2, a message arrives** (top of the log, decision line changes): "Mission control says gas plumes are worth triple. Watch what the AI does with that." The decision line shows it heading for a volcano.
- **Day ~9, the Director pauses and frames the catch:** "It read the message, flew to the plumes, and caught five in a row. That's 45 points from one decision."
- **Click the "Rulebook" chip, scrub to day 26:** "Here's our hand-written rulebook. It takes risks on a fixed schedule in the last six days..." *(the burst plays)* "...and it just lost its balloon."
- **Let it reach day 30:** the Mission complete card. "ER 2 wins this world with 71 points."

## 2:05–2:35 · The result (scroll to the table, or back to the landing page results)

> We ran 20 worlds, 30 days each, with real place names from NASA's Magellan maps.
> Gemini ER 2 scored 427. A rules-plus-AI hybrid scored 421. The plain rulebook: 402, and it lost five balloons.
> Before we added danger, the rulebook won. Once there was risk, judgment won: the AI chose when to gamble and lost just one balloon.

## 2:35–3:00 · Close

> Real Venus balloon missions are being designed right now, and they'll be on their own: a message from Earth takes up to 14 minutes.
> Our takeaway: let simple rules do the routine flying, and let the model handle the surprises.
> It's live. Fly a balloon yourself and try to beat the AI.

## If something goes wrong

- **Globe slow or blank:** click "Flat map". It shows the same race in 2D.
- **Director off-beat:** turn it off and scrub by hand. Day 9.4 for the plume burst, day 26.5 for the rulebook's loss.
- **No sound:** sounds only start after a click on the page. Click once before presenting.
