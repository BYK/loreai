// Use the API so Astro CLI agent detection cannot daemonize the test server.
import { preview } from "astro";

await preview({ server: { host: "127.0.0.1", port: 4331 } });
