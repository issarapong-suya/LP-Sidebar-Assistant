# Setup Wizard

The Setup Wizard is served by the standalone server at `/setup`. Open it locally on the hospital server after starting the service. It configures the hospital identity, HOSxP read-only database connection, access network and Creatinine lab code, then writes `server/config.json`.

The wizard intentionally accepts setup requests only from the Server machine itself. Do not expose the setup page through a public reverse proxy.
