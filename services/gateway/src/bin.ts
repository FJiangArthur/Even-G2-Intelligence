import { createGatewayServer } from "./server.js";

const server = createGatewayServer();
const address = await server.listen();

// This startup line intentionally contains no configuration values or secrets.
process.stdout.write(`Helix gateway listening on ${address.websocketUrl}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
