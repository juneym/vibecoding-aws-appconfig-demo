import express from "express";
import { AWSAppConfig } from "./providers/AWSAppConfig.js";

const configService = new AWSAppConfig({
  applicationId: process.env.APPCONFIG_APPLICATION_ID!, 
  environmentId: process.env.APPCONFIG_ENVIRONMENT_ID!,
  region: process.env.AWS_REGION!,
  pollIntervalMs: 30000,
  discoveryIntervalMs: 120000,
});

/* Set configuration prefix if provided so that any config that has prefix 
 * like dev4_ as in dev4_feature_flags  can be accessed using "feature_flags" only 
 */
if (process.env.CONFIG_PREFIX) {
  configService.setConfigPrefix(process.env.CONFIG_PREFIX);
}

configService.on("ready", ({ profiles }) => console.log(new Date().toISOString(), "[CONFIG_READY] ConfigService: Loaded profiles", profiles));
configService.on("update", ({ profile, config }) => console.log(new Date().toISOString(), "[CONFIG_UPDATED] ConfigService: Updated", profile, config));
configService.on("debug", (eparam) => console.log(new Date().toISOString(), `[DEBUG] ConfigService: Debug  ${eparam.message}`));

(async () => {
  await configService.start();

  const app = express();
  app.get("/configs_all", (req, res) => res.json(configService.getConfigs()));
  app.get("/config", (req, res) => {
    const { name } = req.query;
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "Name parameter is required" });
    }
    // The prefix is handled by getConfig, so we pass the name without it.
    const config = configService.getConfig(name.replace(process.env.CONFIG_PREFIX || "", ""), null);
    if (config) {
      res.json(config);
    } else {
      res.status(404).json({ error: "Config not found" });
    }
  });

  const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
})();
