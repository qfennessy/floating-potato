# Mars Balloon Navigator — Hack Plan

Built at [Sundai Club](https://www.sundai.club) · [Hack 144 — Autonomous Spacecraft Hack](https://www.sundai.club/events/boston/hack-144-autonomous-spacecraft-hack) · Sun Oct 11, 2026 · MIT

## Pitch

Balloons can't steer, but they can choose their wind. Our agent flies a balloon across Mars by changing altitude, reaching science targets that neither a rover nor a helicopter could cover.

Why it matters: Mars's air is about 1% as dense as Earth's, so lift is weak, but winds change direction sharply with height and between day and night. A balloon that picks its altitude can cover thousands of km. Google's Loon proved this kind of altitude steering on Earth with reinforcement learning; we port the idea to Mars and add an LLM mission commander on top.

Win condition for the demo: the agent reaches more targets and covers more ground than a balloon that just drifts.

## How the simulation works

A 2D map plus an altitude dimension, stepped every 15 simulated minutes.

| Element | What it holds |
|---|---|
| State | Latitude, longitude, altitude, time of sol, buoyancy budget |
| Actions | Ascend, hold, or descend, one choice per step |
| Wind field | u, v wind by altitude band, location, and time of sol, interpolated from a small table |
| Targets | 4–6 named science sites, each with a capture radius |
| Score | Targets reached, km covered, sols elapsed |

The constraint that makes it interesting: model a solar Montgolfière (a hot-air balloon heated by sunlight). It can climb only in daylight and sinks at night, so the agent has to plan around sunset. An audience understands this immediately.

Keep the physics simple: altitude changes at a fixed rate per step, and horizontal motion equals the wind at the current altitude. Nobody will judge buoyancy equations; they will judge whether the agent makes smart choices.

## Controllers

The LLM decides where to go; a search-based planner decides how. Keeping the LLM out of the step-by-step control is deliberate: it is slow and imprecise at that, but good at weighing goals and explaining choices.

```
┌─────────────────────┐     target + rationale     ┌─────────────────────┐
│  LLM commander      │ ─────────────────────────▶ │  Search planner     │
│  picks the target,  │                            │  ascend / hold /    │
│  writes the log     │ ◀───────────────────────── │  descend per step   │
└─────────────────────┘   position, time, targets  └──────────┬──────────┘
                                                              │ action
                                                              ▼
┌─────────────────────┐                            ┌─────────────────────┐
│  Drifter baseline   │ ──── same sim, fixed ────▶ │  Simulator          │
│  (fixed altitude)   │        altitude            │  winds, day/night,  │
└─────────────────────┘                            │  scoring            │
                                                   └─────────────────────┘
```

The drifter flies the same sim at a fixed altitude, so the comparison is fair. Stretch goal: swap the planner for an RL policy and close with "Loon did this on Earth; here's Mars."

## Shortcuts and data sources

- **Simulator:** fork Google's open-source Balloon Learning Environment (Python, gym-style, from the Loon work) and replace Earth's wind with Mars winds. If it fights you by 13:00, drop it and write a plain 2D sim, about 100 lines of numpy.
- **Winds:** the Mars Climate Database web interface exports wind profiles. Pull a small table on Saturday: a few locations × 8 altitude bands × 12 times of sol. Fallback: synthetic layered winds whose direction rotates with altitude and flips day to night.
- **Map:** a MOLA or Viking global mosaic image as the background.
- **Targets:** real sites so the story lands: Jezero Crater, Gale Crater, Valles Marineris, Olympus Mons, plus one "surprise" target (for example a reported methane detection) that the commander can choose to chase.
- **Deployment:** the live site replays precomputed runs as JSON, so the demo cannot crash. Run the agent live only as a bonus.

## Demo design

One web page that tells the story in 3 minutes:

- **Map:** the Mars basemap with the drifter's track in grey and the agent's track in color, animated side by side.
- **Targets:** markers that turn green when reached.
- **Day/night bar:** shading under the map that shows when the balloon can climb.
- **Altitude strip:** a small chart of altitude over time, so viewers see the agent switching wind layers.
- **Commander log:** a sidebar where the LLM's decisions appear as they happen ("Sunset in 2 h, holding at 6 km to ride the westward layer toward Gale").
- **Closing numbers:** targets reached and km covered, agent vs. drifter.

Pitch arc: the problem (Mars is big, rovers are slow), the trick (altitude steering), the replay, the numbers, then one line on what this would mean for a real mission.

## Team and timeline

Ideal team is 3–4 people. If you're short, the frontend person also takes the commander.

| Role | Owns | Done when |
|---|---|---|
| Sim and winds | Environment, wind table, scoring | The drifter runs end to end and outputs a track |
| Planner | Search controller, day/night logic | The planner beats the drifter on targets reached |
| Agent | LLM commander, mission log | The commander picks targets and writes a readable log |
| Frontend | Map, replay, deployment | A public URL replays both runs |

Sunday schedule (hack time runs 12:00–20:00; the [event page](https://www.sundai.club/events/boston/hack-144-autonomous-spacecraft-hack) has the full day, starting 10:00):

1. **12:00–14:00:** pitch, form the team, get the drifter flying and one track drawn on the map.
2. **14:00 check-in:** show the end-to-end loop, even if ugly.
3. **14:00–17:00:** the planner beats the drifter; the commander is connected.
4. **17:00–19:00:** add the day/night constraint, polish the replay, save backup runs.
5. **19:00–20:00:** deploy, rehearse the 3-minute pitch twice.

If the 16:00 run/bike tempts you, take it only if the planner already works.

## Prep, risks, and questions

**Before Sunday**

- [ ] Export the Mars wind table from the Mars Climate Database (or write the synthetic fallback)
- [ ] Clone the Balloon Learning Environment and confirm it installs
- [ ] Download a Mars basemap image and pick the 4–6 target sites
- [ ] Write the noon pitch: two sentences and one sketch of the map
- [x] Set up a repo and a static hosting target

**Risks and fallbacks**

| Risk | Fallback |
|---|---|
| Balloon Learning Environment takes too long to adapt | Plain 2D numpy sim |
| No usable Mars wind data | Synthetic layered winds |
| Planner doesn't beat the drifter | Tune target placement so altitude choice clearly matters |
| LLM commander is slow or flaky live | Replay logged decisions from precomputed runs |

**Questions for Alejandro Carrasco Aragón** (guest speaker, MIT AeroAstro; talk at 11:00)

- In your KSP agent work, did LLMs do better at long-horizon planning or at reactive control? (This justifies our commander-plus-planner split.)
- What would a real Mars balloon mission need from onboard autonomy that our demo ignores?
