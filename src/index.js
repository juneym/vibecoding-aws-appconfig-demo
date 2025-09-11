import express from "express";
import { ConfigurationService } from "./ConfigurationService.js";

// console.log('APPCONFIG_APPLICATION_ID:', process.env.APPCONFIG_APPLICATION_ID);
// console.log('APPCONFIG_ENVIRONMENT_ID:', process.env.APPCONFIG_ENVIRONMENT_ID);
// console.log('AWS_REGION:', process.env.AWS_REGION);

const configService = new ConfigurationService({
  applicationId: process.env.APPCONFIG_APPLICATION_ID,
  environmentId: process.env.APPCONFIG_ENVIRONMENT_ID, 
  region: process.env.AWS_REGION,
  pollIntervalMs: 30000,
});

configService.on("ready", ({ profiles }) => console.log("ConfigService: Loaded profiles", profiles));
configService.on("update", ({ profile }) => console.log("ConfigService: Updated", profile));

await configService.start();

const app = express();
app.get("/configs_all", (req, res) => res.json(configService.getConfigs()));
app.get("/config", (req, res) => {
  const { name } = req.query;
  if (!name) {
    return res.status(400).json({ error: "Name parameter is required" });
  }
  const config = configService.getConfig(name, null);
  if (config) {
    res.json(config);
  } else {
    res.status(404).json({ error: "Config not found" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
