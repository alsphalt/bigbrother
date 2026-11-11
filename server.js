// Long-running entrypoint: local development and any VPS/container/VM host.
// Serverless platforms use api/index.js instead.
import app from "./app.js";

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => console.log(`Darknote Cloud v0.2 listening on ${port}`));
