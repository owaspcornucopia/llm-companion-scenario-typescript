import { createApp, setupDb } from "./app.js";

// Let deployments choose the database location; local runs get the thrillingly original db.sqlite file.
const dbPath = process.env.DB_CONNECTION_STRING ?? "db.sqlite";
// Build the small demonstration data set before accepting requests that depend on it.
setupDb(dbPath);
// Listen on every network interface so the container can be reached from outside its tiny private kingdom.
createApp(dbPath).listen(9000, "0.0.0.0", () => console.log("App ready on port 9000."));