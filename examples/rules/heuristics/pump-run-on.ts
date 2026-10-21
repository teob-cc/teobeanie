// pump-run-on — the circulation pump runs while the boiler heats, and 20 minutes
// after it stops. The trigger package's follow-with-run-on, as one expression.

import { minutes, rule } from "teobeanie";

export default rule("pump-run-on", ({ ha, within }) =>
  ha.switch.circulation_pump.to(within(() => ha.binary_sensor.boiler_heating.is("on"), minutes(20)) ? "on" : "off"),
);
