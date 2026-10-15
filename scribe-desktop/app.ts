import app from "ags/gtk4/app";
import style from "./style.scss";
import Bubble from "./Bubble";
import { press, release } from "./session";

// Resident dictation daemon (run it as a user service). Key press and release
// binds reach it over D-Bus (io.Astal.scribe-desktop Request, see the README),
// without spawning a process per keypress.
app.start({
  instanceName: "scribe-desktop",
  css: style,
  gtkTheme: "Adwaita",
  requestHandler(argv, res) {
    if (argv[0] === "press") press();
    else if (argv[0] === "release") release();
    res("ok");
  },
  main(...argv: string[]) {
    // A forwarded request only reaches main() when no daemon is running; don't
    // start a stray one outside the service.
    if (argv.length > 0) {
      app.quit();
      return;
    }
    app.add_window(Bubble());
  },
});
