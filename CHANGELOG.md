# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

- Fixed: a rule just added disappeared when the list was filtered, or when "Enabled only" was ticked, since it starts with a placeholder name and switched off

- A slider comes on at the level the device itself keeps, with a setting of its own for a device that has none, rather than always starting at the first step
- Each slider button takes several triggers, so one slider can be driven by more than one remote
- Fixed: slider entries in the activity log had an empty kind pill, and a slider with nothing to do said "skipped"
- A Sliders tab drives a dimmer or a fan from buttons: a level cut into steps, with a press moving it one step and the ends switching the device on and off

- Delete on a rule sits at the far end of the footer, is red, and asks once before deleting anything that has been saved. It goes back to asking after two seconds

## [0.12.0] - 2026-08-22

### Added

- A Map tab draws the Zigbee network: the hub on the left and a column per hop out from it, so what reaches it directly and what goes through something else can be read down the page. Every link found is drawn, with the route each device uses picked out, and clicking a device says what it can hear and how well. A device the scan found but nothing connects to is drawn dashed rather than left out
- Automations sorted by trigger are listed under the device that sets them off, one line per trigger, so a remote with six buttons reads as six lines. A rule with several triggers appears under each of them

### Changed

- An outcome is called what it was named in the activity log, falling back to its number
- A rule just added stays at the top of its list until it is saved, rather than sorting under a name nobody has chosen yet
- Sorting automations by target device is gone
- Mirror device selection runs down three columns instead of wrapping across the page
- Described devices sit behind a collapsed panel in the config form, with Rules only moved up under ID

### Fixed

- A child lock ticked on a socket showed nothing in the Home app. HomeKit allows a physical lock on its air services only, so on anything but a fan the lock now gets a switch of its own
- Every healthy router was reported as having failed the network scan, since an empty list of unanswered requests reads as true
- A tick box in the mirror editor was stretched to the width of a value box

## [0.11.0] - 2026-08-22

### Added

- A flat JSON source can describe functions a device has but never reports, such as the speed and swing of a fan. What was described is logged at startup, and a described topic nothing reports on is named in a warning alongside the topics that did
- Outcomes can be named, beside a remove button that is now a plain cross

### Changed

- The automation editor keeps "or", "and" and the buttons that add another on the row they belong to, instead of each on a line of its own
- Remove group sits at the top right of its box
- Outcomes are spaced apart and faintly shaded
- Rule rows have fixed widths, so the columns line up from one row to the next
- Number inputs are styled like every other input instead of unstyled, which is what made the delay box look out of place
- In the config form, described devices sit behind a collapsed panel and Rules only moved up under ID

### Fixed

- Sorting and filtering on the Automation and Mirror tabs, which threw on any rule saved since outcomes arrived and emptied both tabs without saying why
- The device picker in a rule was styled as a device card, since it shared its class

## [0.10.0] - 2026-08-21

### Changed

- The broker is configured as one address, `localhost:1883`, instead of a separate host and port. The port may be left off. A host and port stored separately are still read, so an existing install keeps its broker
- Broker username and password only appear once "Requires authentication" is ticked, and are ignored when it is not

## [0.9.1] - 2026-08-20

### Fixed

- Accessories are no longer dropped and re-added on every start. The catalog is empty before the broker answers because nothing has arrived, not because there is nothing, and removing an accessory makes HomeKit forget which room it is in

## [0.9.0] - 2026-08-20

### Added

- A rule can have several outcomes, each a condition and its own actions. The first that holds runs and the rest are skipped, which is if, else if and else
- Any outcome may be left without a condition, meaning it always holds
- The activity list says which outcome ran, and what each wanted when none did

## [0.8.0] - 2026-08-20

### Added

- Conditions are an expression: groups joined by or, tests within a group joined by and, and any group can be negated
- A rule can have several triggers, any of which fires it
- The interface header shows the version on a released build, or the branch it was built from on any other

### Changed

- Failing an or reports what every branch had against it, rather than only the first

## [0.7.0] - 2026-08-20

### Added

- Activity is its own tab, listing both kinds of rule with each entry saying which it came from
- Each tab offers the controls that suit it: In HomeKit only on Devices, Enabled only on the rule tabs, a checkbox per kind on Activity
- Rule lists can be ordered by name, or by the first device on either side, and filtered by the devices a rule touches as well as its name

### Changed

- Automation and mirrored devices are separate tabs rather than one list behind a checkbox
- Filters and orderings are kept per tab

## [0.6.1] - 2026-08-19

### Added

- Optional link to the Zigbee2MQTT interface in the tab bar, set with `web.zigbee2mqttUrl`

## [0.6.0] - 2026-08-19

### Added

- Sort the device list by name, topic, device or when it was last heard from

### Changed

- Device pickers in rules are always ordered by name, whatever the device list is sorted by

## [0.5.0] - 2026-08-19

### Added

- Rules engine: when something happens on one device, send something to another, across sources
- Triggers, optional conditions and one or more actions, with optional delays
- An action can send a fixed value or match whatever triggered the rule, translated into the target's terms
- Mirror rules: pick devices and the functions to keep in step, every member both trigger and target
- Rule editor and a run log in the web interface
- Devices whose source does not name them can be renamed, from a pencil in the card header
- Show when a device was last heard from, and the local time behind any timestamp value
- Filter devices by name, topic, model or manufacturer, and hide anything not in HomeKit
- Toggle offered as an action wherever a device understands one

### Changed

- Rules never run on retained messages, so reconnecting cannot replay an old press
- Per rule rate limit, a settling window for mirrors, and a rule that runs away is turned off and logged
- Accessory names are corrected to what HomeKit accepts, rather than warned about on every start
- Values that have not moved are no longer sent to HomeKit
- State is copied at startup, and what was loaded is reported in the log

### Fixed

- The interface is sent the words a device uses for on and off, instead of assuming ON and OFF
- Endpoints are named in rule dropdowns, so a device's channels can be told apart
- A characteristic with no value yet reports the last known one rather than failing the read

## [0.4.1] - 2026-08-18

### Changed

- Marked private, since the package is not published. `npm publish` now refuses rather than putting it on the registry by accident
- Installation documents the only route that works, installing from source, rather than leading with an npm package that does not exist

## [0.4.0] - 2026-08-18

First release. Everything below arrived across v0.1.0 to v0.4.0, none of which was published separately.

### Added

- Homebridge platform plugin connecting to one MQTT broker shared by every source
- Pluggable source adapters producing one normalised device model, so the HomeKit mapping never sees a source format
- Zigbee2MQTT source discovering devices and their functions from `bridge/devices`, updating live on joins, renames and removals
- `json-topic` source for publishers that put flat JSON on a topic per device, with properties inferred from the keys seen and unrecognised keys kept rather than dropped
- Sources can be marked rules only, for devices another plugin already publishes to HomeKit
- Password protected web interface listing every device and function, with live values over server sent events
- Tick a function to publish it to HomeKit, applied immediately with no Homebridge restart
- Tile type per endpoint, optional separate accessory per endpoint, and name overrides
- Rename devices whose source does not name them itself
- Filter devices by name, topic, model or manufacturer, and hide anything not in HomeKit
- HomeKit mapping for on/off, brightness, fan speed and swing, thermostat, temperature, humidity, battery and child lock
- Buttons inferred from the actions a device publishes, one service per physical button, with per gesture selection
- Property name to characteristic table, so a new kind of sensor needs no change to the mapper
- Functions with no HomeKit equivalent stay listed and marked, ready for the rules engine
- Persistent state under the Homebridge storage path, kept out of `config.json`
