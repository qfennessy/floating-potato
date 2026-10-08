# Venus Balloon Navigator — Hack Plan

Built at [Sundai Club](https://www.sundai.club) · [Hack 144 — Autonomous Spacecraft Hack](https://www.sundai.club/events/boston/hack-144-autonomous-spacecraft-hack) · Sun Oct 11, 2026 · MIT

## Pitch

Balloons can't steer, but they can choose their wind. Our agent flies a balloon through the clouds of Venus by changing altitude, reaching science targets that no lander can survive long enough to visit.

Why it matters: Venus's surface is 460 °C and 90 atmospheres, so landers die in hours. But 50–60 km up, in the cloud deck, pressure and temperature are close to Earth's, and the whole atmosphere "superrotates": it circles the planet every 4 Earth days, far faster than the planet spins. Balloons are the one flight-proven way to live there: the Soviet-French Vega 1 and Vega 2 balloons flew at 54 km for about two days each in 1985 and covered roughly 11,000 km. They just couldn't choose where they went. Wind speed on Venus climbs steeply with altitude, and the north-south drift flips sign between the cloud top and the cloud base, so a balloon that picks its altitude picks its speed and its latitude. Google's Loon proved this kind of altitude steering on Earth with reinforcement learning; we port the idea to Venus and put an embodied-reasoning model in command.

Win condition for the demo: the agent reaches more targets in the same number of Earth days than a balloon that rides one altitude around the planet.

## How the simulation works

A 2D map plus an altitude dimension, stepped every 15 simulated minutes (at 100 m/s that is about 90 km per step, so one lap of the planet is roughly 400 steps).

| Element | What it holds |
|---|---|
| State | Latitude, longitude, altitude, Earth-hours elapsed, local solar time, buoyancy budget |
| Actions | Ascend, hold, or descend, one choice per step |
| Wind field | u, v wind by altitude band, latitude, and local time, interpolated from a small table |
| Targets | 4–6 named science sites, each with a capture radius |
| Score | Targets reached, laps flown, Earth days elapsed |

The constraint that makes it interesting: the balloon lives in a narrow corridor, about 50–62 km. Below it the air is too hot for the envelope; above it the sulfuric-acid cloud top and thinning air end the ride. Inside the corridor, altitude is a speed dial: roughly 60 m/s near the bottom and 100 m/s near the top, always westward. You can never fly backward. Every target comes around again on the next lap, so the game is phasing: pick the altitude that puts you at the target's longitude when your slow north-south drift has brought you to its latitude. An audience understands "conveyor belt plus a speed dial" immediately.

Keep the physics simple: altitude changes at a fixed rate per step, and horizontal motion equals the wind at the current altitude. Nobody will judge buoyancy equations; they will judge whether the agent makes smart choices.

## Controllers

The commander decides where to go; a search-based planner decides how. Keeping the model out of the step-by-step control is deliberate: it is slow and imprecise at that, but good at weighing goals, reading a map, and explaining choices.

**Commander: Gemini Robotics-ER 2** (`gemini-robotics-er-2-preview`, Google's embodied-reasoning model, public preview since July 2026). It is built for exactly this split: spatial reasoning over images, breaking a task into sub-tasks, and multi-step tool use with function calling. We hand it the rendered map (tracks, targets, the safe corridor) as an image plus a short state summary, and expose two tools: `set_target(site)` and `set_altitude_band(km_low, km_high)`. Run it at `thinking_level: "medium"`. Its streaming sibling (`gemini-robotics-er-2-streaming-preview`, Live API) is the bonus path for a live-narrated run.

```
┌─────────────────────┐     target + corridor      ┌─────────────────────┐
│  Commander          │ ─────────────────────────▶ │  Search planner     │
│  Gemini Robotics-ER │                            │  ascend / hold /    │
│  reads the map,     │ ◀───────────────────────── │  descend per step   │
│  picks the target,  │   position, time, targets  └──────────┬──────────┘
│  writes the log     │                                       │ action
└─────────────────────┘                                       ▼
┌─────────────────────┐                            ┌─────────────────────┐
│  Drifter baseline   │ ──── same sim, fixed ────▶ │  Simulator          │
│  (fixed altitude,   │        altitude            │  winds, corridor,   │
│   like Vega 1985)   │                            │  scoring            │
└─────────────────────┘                            └─────────────────────┘
```

The drifter flies the same sim at a fixed altitude, so the comparison is fair, and it is historically honest: that is what Vega did. Stretch goal: swap the planner for an RL policy and close with "Loon did this on Earth, Vega flew Venus blind in 1985; here is Venus with eyes."

## Shortcuts and data sources

- **Simulator:** fork Google's open-source Balloon Learning Environment (Python, gym-style, from the Loon work) and replace Earth's wind with Venus winds. If it fights you by 13:00, drop it and write a plain 2D sim, about 100 lines of numpy.
- **Winds:** the Venus Climate Database (the LMD group's Venus counterpart of the Mars Climate Database, current release v2.3) gives wind profiles by altitude, latitude, and local time. Pull a small table on Saturday: a few latitudes × 8 altitude bands × 12 local times. Fallback: synthetic winds with zonal speed rising from 60 to 100 m/s across the corridor, a few m/s poleward at the cloud top, equatorward near the base. Sanity-check against the published Vega balloon tracks.
- **Map:** a Magellan radar mosaic as the background.
- **Targets:** real sites so the story lands: Maxwell Montes (the highest peak), Maat Mons (the volcano that was caught changing shape in Magellan data), Alpha Regio (where NASA's DAVINCI probe is headed), Ovda Regio in Aphrodite Terra, plus one "surprise" target (for example a fresh sulfur-dioxide plume) that the commander can choose to chase.
- **Commander:** Gemini API key from Google AI Studio; confirm `gemini-robotics-er-2-preview` answers a tool call before Sunday. Keep the same tool schema so the planner never cares which model is behind it.
- **Deployment:** the live site replays precomputed runs as JSON, so the demo cannot crash. Run the agent live only as a bonus.

## Demo design

One web page that tells the story in 3 minutes:

- **Map:** the Magellan basemap with the drifter's track in grey and the agent's track in color, animated side by side as both lap the planet.
- **Targets:** markers that turn green when reached.
- **Corridor strip:** a small chart of altitude over time with the 50–62 km safe band shaded, so viewers see the agent switching wind layers and staying alive.
- **Commander log:** a sidebar where the model's decisions appear as they happen ("Maat Mons is 40° ahead and 10° south; dropping to 52 km to slow down and let the equatorward drift bring me onto it").
- **Closing numbers:** targets reached and laps flown, agent vs. drifter, in the same Earth days.

Pitch arc: the problem (Venus kills landers, the clouds are the only place to live), the precedent (Vega flew there in 1985 but blind), the trick (altitude steering), the replay, the numbers, then one line on what this would mean for a real mission.

## Team and timeline

Ideal team is 3–4 people. If you're short, the frontend person also takes the commander.

| Role | Owns | Done when |
|---|---|---|
| Sim and winds | Environment, wind table, corridor, scoring | The drifter laps the planet end to end and outputs a track |
| Planner | Search controller, phasing logic | The planner beats the drifter on targets reached |
| Commander | Gemini Robotics-ER tools, prompt, mission log | The commander picks targets from the map image and writes a readable log |
| Frontend | Map, replay, deployment | A public URL replays both runs |

Sunday schedule (hack time runs 12:00–20:00; the [event page](https://www.sundai.club/events/boston/hack-144-autonomous-spacecraft-hack) has the full day, starting 10:00):

1. **12:00–14:00:** pitch, form the team, get the drifter flying and one track drawn on the map.
2. **14:00 check-in:** show the end-to-end loop, even if ugly.
3. **14:00–17:00:** the planner beats the drifter; the commander is connected and calling tools.
4. **17:00–19:00:** add the corridor constraint, polish the replay, save backup runs.
5. **19:00–20:00:** deploy, rehearse the 3-minute pitch twice.

If the 16:00 run/bike tempts you, take it only if the planner already works.

## Prep, risks, and questions

**Before Sunday**

- [ ] Export the Venus wind table from the Venus Climate Database (or write the synthetic fallback)
- [ ] Clone the Balloon Learning Environment and confirm it installs
- [ ] Download a Magellan basemap image and pick the 4–6 target sites
- [ ] Get a Gemini API key and confirm Gemini Robotics-ER 2 returns a tool call in AI Studio
- [ ] Write the noon pitch: two sentences and one sketch of the map
- [x] Set up a repo and a static hosting target

**Risks and fallbacks**

| Risk | Fallback |
|---|---|
| Balloon Learning Environment takes too long to adapt | Plain 2D numpy sim |
| No usable Venus wind data | Synthetic layered winds tuned to the Vega profile |
| Planner doesn't beat the drifter | Tune target latitudes so altitude choice clearly matters |
| Gemini Robotics-ER 2 preview is rate-limited or flaky live | Same tool schema on a general Gemini model; replay logged decisions from precomputed runs |

**Questions for Alejandro Carrasco Aragón** (guest speaker, MIT AeroAstro; talk at 11:00)

- In your KSP agent work, did LLMs do better at long-horizon planning or at reactive control? (This justifies our commander-plus-planner split.)
- Does an embodied-reasoning model like Gemini Robotics-ER actually read a map better than a general model, or is the gain all in the tool-use loop?
- What would a real Venus balloon mission need from onboard autonomy that our demo ignores?
