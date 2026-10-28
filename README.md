# VGS Display for BeamNG.drive

A per-wheel grip display inspired by Enthusia's VGS. Each wheel is drawn where it sits on the vehicle, inside a circle that's always the same size. Coupled vehicles (trailers, dollies, separately spawned bus sections) are drawn as outlined boxes stacked front to back and shrunk to fit inside the circle. Everything is drawn to scale: each vehicle is centred on and outlined by its actual body (measured from its structure when it spawns), each tyre is drawn at its real diameter and 1.5 times its real width so it's easy to see (`TYRE_WIDEN` in `app.js`), and each wheel sits at its real position. A trailer with its axles at the back shows its long empty front section, whether you're driving the tractor or have switched to the trailer itself.

| Part of the wheel | Meaning |
|---|---|
| Inner bar, growing from the centre | Share of the tyre's grip in use |
| Inner bar solid red | Grip limit exceeded (tyre sliding): a greyish light red just past the limit, deepening to saturated red as the slide grows |
| Outline grey → green | Drive torque applied |
| Outline grey → red | Braking torque applied (brakes, engine braking, regen) |
| Rotation | Live steering angle of that wheel |
| Dashed outline | Wheel broken off |
| Red dot beside the wheel | ABS is releasing that wheel's brake |
| Blue dot beside the wheel | ESC is braking that wheel |
| Green dot under the engine | Traction control is intervening |
| No dot | No assist is intervening |

Dual tyres draw side by side with a small gap. They're found two ways: separate wheels on the same side of an axle within 0.6 m of each other (including ones at the same hub, placed using `wheelOffset`), or one wheel that stands in for a pair, detected from a dual flag, a tyre mesh named "dual", or a truck-sized tyre much wider than it is tall (`DUAL_WIDTH_RATIO`). A dual set shares one assist dot and one numeric readout per corner (showing the harder-working tyre). Each dot stays lit for 0.3 s after the last detection (`ASSIST_HOLD`) so fast-pulsing ABS stays readable; if ABS and ESC hit the same wheel, ESC wins.

How each is detected: ABS comes straight from each wheel's own ABS flag. TC comes from the vehicle's traction-control flag; it works through the engine, so it gets one dot rather than one per wheel. ESC is only reported for the whole vehicle, so its dot goes on the wheels it's braking, found from brake torque the pedals didn't ask for. ESC dots only appear when the car reports it's fitted with ESC (`hasESC`) and ESC is intervening (`escActive`), and never when every wheel is braked evenly, since stability control works by braking individual wheels. A spinning driven wheel being braked under power counts as TC, not ESC.

Around the rim of the circle are your inputs, each filling up to a quarter turn:

| Arc | Meaning |
|---|---|
| Blue, from 12 o'clock | Steering: grows towards 9 o'clock turning left, towards 3 o'clock turning right; a full quarter at full lock |
| Red, from 6 o'clock towards 9 | Brake pedal |
| Green, from 6 o'clock towards 3 | Throttle pedal |

They're read the same way as BeamNG's own Steering and Pedals apps: `steering_input` (negative to the left), and the applied `throttle` and `brake`, so the arcs match those apps. `brake` includes the automatic brake hold, so the red arc can show a little while stopped with your foot off the pedal. 

The yellow dot is the G-force you feel: braking pushes it towards the front, accelerating towards the back, and a left turn pushes it right. The edge of the circle is 1.5 g (`GF_MAX` in `app.js`), so a road car's limit of about 1 g reaches two-thirds of the way out. Where it has been over the last 0.8 s (`TRAIL_MS`) is drawn as a trail of fading copies. It's measured from the change in the car's velocity, so it reads zero when parked on a hill. It's taken from the vehicle you're driving.

Underneath the wheels is the drivetrain, read from the vehicle's powertrain so front-, mid- and rear-engined cars and FWD, RWD, AWD and multi-motor EVs all draw themselves:

| Element | Meaning |
|---|---|
| Line between paired wheels | Axle; driven half-shafts tinted by the torque going to that wheel. Fainter and thinner where nothing drives the wheels |
| Faint thin centre line | Chassis spine, front axle to rear axle; the driveshaft is drawn over it at full strength, so only the stretch with no driveshaft stays faded |
| Block | Combustion engine, on the centreline at its fore/aft position |
| Ringed circle | Electric motor; one that drives wheels on one side only keeps its side position |
| Line from engine/motor | Driveshaft to what it drives, tinted by drive torque (green) or engine braking / regen (red); friction brakes don't tint it |
| Small square | Differential: hollow = open, hollow with a centre block = limited-slip (LSD, viscous, active), solid = locked. Updates live when you lock or unlock a diff |
| Small block with an "H" | Gearbox |
| Dashed shaft | Disconnected right now (e.g. the front driveshaft of a part-time 4WD in 2WD); the wheels it feeds count as undriven |
| Dashed engine/motor | Position couldn't be found in the vehicle data, so it's placed at the wheels it drives |

The drivetrain is read the same way as BeamNG's Powertrain app: each engine or motor is followed through the gearbox and differentials (including centre and inter-axle diffs) to the wheels. Lock state comes from each differential's current mode, falling back to its type. The gearbox's fore/aft position and the transfer case are taken from where the vehicle's structure has nodes named for them. The gearbox is always drawn on the centreline, in line with the engine. Otherwise it goes next to the engine on the side facing the wheels it drives, or just behind it, towards the middle of the vehicle, when the engine sits on one of its driven axles (a transverse engine). A centre diff or transfer case goes near the gearbox, on the centreline just behind the front diff for a transverse-engine AWD, or just ahead of the axles it feeds on a truck. Every driveshaft is tinted by the torque reaching the wheels it feeds, so an on-demand AWD's rear driveshaft stays grey until the transfer case starts sending torque back, then turns green. The engine block is drawn larger than life so it stays readable, so a gearbox the vehicle places right against the engine is moved just clear of the block, towards the wheels it drives. Differentials are drawn over engines and gearboxes, so a transaxle's diff stays visible.

Only engines and motors that drive wheels are drawn, so motors for hydraulics, winches or trailer landing gear don't show up.

Click the app to show grip % and contact slip (m/s) next to each wheel.

## Install

Put `vgs_display.zip` in your BeamNG `mods` folder (unzipped is fine too), start the game, open the UI app selector and add **VGS Display** (Debug category). Make the app taller for trucks and buses.

## Files

- `lua/vehicle/extensions/vgsTelemetry.lua` — runs inside each displayed vehicle; measures the wheels.
- `lua/ge/extensions/vgsHub.lua` — finds the player vehicle plus anything coupled to it, orders them, sends `VGSUpdate` to the UI.
- `ui/modules/apps/VGSDisplay/` — the app (canvas renderer + Angular directive).

## Calibrating grip

BeamNG doesn't expose a direct "friction used" figure per tyre, so grip use is an estimate: the larger of a force-based figure (drive/brake torque and lateral acceleration against the wheel's load) and contact-patch slip measured against `SLIP_PEAK`. The tunables are at the top of `vgsTelemetry.lua`:

- `SLIP_PEAK` — slip (m/s) that reads as 100 %.
- `SLIP_LIMIT` — slip (m/s) where the wheel turns red.
- `SLIP_FULL` — slip (m/s) shown as the deepest red (default 8, a full spin or lock-up). The red deepens on a log scale between the two.
- `MU_NOMINAL` — assumed friction coefficient; raise it for race tyres.

Turn on the numbers, do a clean launch and a steady corner at the limit, and note the slip where the car actually lets go. Set `SLIP_LIMIT` just below it and `SLIP_PEAK` a bit lower. Reload vehicle Lua (Ctrl+R) to apply changes.

## If dual tyres don't show

Open the vehicle Lua console (`~`, switch to the vehicle context) and run:

```
extensions.load("vgsTelemetry") extensions.vgsTelemetry.dumpWheels()
```

It prints one line per wheel with its position, radius, width, offset, groups and how many tyres were detected. The widths and groups show which rule needs adjusting.

## If the drivetrain looks wrong

In the vehicle Lua console run:

```
extensions.load("vgsTelemetry") extensions.vgsTelemetry.dumpDrivetrain()
```

It lists every powertrain device (type, differential type, mode, what it feeds) and then what the VGS draws from them.

## Known limits

- An articulated bus built as one vehicle shows in a single panel.
- If you open the app after hitching a trailer and it doesn't appear, unhitch and re-hitch once.
- The drivetrain is mapped when the vehicle spawns or resets. Swapping a powertrain part reloads the vehicle, which re-maps it.
- Engine position comes from the engine's torque-reaction nodes, then from nodes in an engine group. Mods that define neither get the dashed, estimated position.
