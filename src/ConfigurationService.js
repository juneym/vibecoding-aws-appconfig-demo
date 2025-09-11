import { EventEmitter } from "node:events";
import {
  AppConfigClient,
  ListConfigurationProfilesCommand
} from "@aws-sdk/client-appconfig";
import {
  AppConfigDataClient,
  StartConfigurationSessionCommand,
  GetLatestConfigurationCommand
} from "@aws-sdk/client-appconfigdata";
import yaml from "js-yaml";

const textDecoder = new TextDecoder();

function parseConfig(raw, contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("json")) return JSON.parse(raw);
  if (ct.includes("yaml") || ct.includes("yml")) return yaml.load(raw);
  try { return JSON.parse(raw); } catch { return yaml.load(raw); }
}

function stableHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
  return (h >>> 0).toString(16);
}

export class ConfigurationService extends EventEmitter {
  #control; #data;
  #opts;
  #timers = new Map();
  #tokens = new Map();
  #hashes = new Map();
  #closed = false;

  /** { [profileName]: { raw, parsed, contentType, version, updatedAt } } */
  #configsCache = {};
  getConfigs() {
    return this.#configsCache;
  }


  /**
   * Retrieves a configuration value by its name from the cache
   * @param {string} name - The name/key of the configuration to retrieve
   * @param {*} defaultValue - The default value to return if the configuration is not found
   * @returns {*} The parsed configuration value if found in cache, otherwise the default value
   */
  getConfig(name, defaultValue) {
    if (name in this.#configsCache) {
      return this.#configsCache[name].parsed;
    }
    return defaultValue;
  }

  constructor(opts) {
    super();
    if (!opts?.applicationId || !opts?.environmentId || !opts?.region) {
      throw new Error("applicationId, environmentId, and region are required");
    }

    this.#opts = { pollIntervalMs: 30000, ...opts };

    // Use region from constructor
    this.#control = new AppConfigClient({ region: this.#opts.region });
    this.#data = new AppConfigDataClient({ region: this.#opts.region });
  }

  async start() {
    const profiles = await this.#listProfiles();
    for (const p of profiles) {
      await this.#startProfile(p);
      await this.#pollOnce(p);
      const t = setInterval(
        () => this.#pollOnce(p).catch(err => this.emit("error", err)),
        this.#opts.pollIntervalMs
      );
      this.#timers.set(p.Name, t);
    }
    this.emit("ready", { profiles: profiles.map(p => p.Name) });
  }

  async close() {
    this.#closed = true;
    for (const t of this.#timers.values()) clearInterval(t);
    this.#timers.clear();
  }

  async #listProfiles() {
    const profiles = [];
    let next;
    do {
      const resp = await this.#control.send(
        new ListConfigurationProfilesCommand({
          ApplicationId: this.#opts.applicationId,
          NextToken: next
        })
      );
      profiles.push(...(resp.Items ?? []));
      next = resp.NextToken;
    } while (next);
    return profiles;
  }

  async #startProfile(profile) {
    if (!profile?.Id || !profile?.Name) {
      throw new Error('Profile must have Id and Name properties');
    }
    try {
      const start = await this.#data.send(
      new StartConfigurationSessionCommand({
        ApplicationIdentifier: this.#opts.applicationId,
        EnvironmentIdentifier: this.#opts.environmentId,
        ConfigurationProfileIdentifier: profile.Id
      })
      );
      if (!start?.InitialConfigurationToken) {
      console.warn(`Skipping profile ${profile.Name}: No active deployment`);
      return;
      }
      this.#tokens.set(profile.Name, start.InitialConfigurationToken);
    } catch (error) {
      console.warn(`Skipping profile ${profile.Name}: ${error.message}`);
      return;
    }
  }

  async #pollOnce(profile) {
    const name = profile.Name;
    console.log(`[Polling] Profile: ${name} at ${new Date().toISOString()}`);
    const token = this.#tokens.get(name);
    if (!token) return;

    const resp = await this.#data.send(
      new GetLatestConfigurationCommand({ ConfigurationToken: token })
    );

    if (resp.NextPollConfigurationToken) {
      this.#tokens.set(name, resp.NextPollConfigurationToken);
    }

    if (resp.Configuration && resp.Configuration.byteLength > 0) {
      const raw = textDecoder.decode(resp.Configuration);
      const hash = stableHash(raw);

      if (this.#hashes.get(name) !== hash) {
        this.#hashes.set(name, hash);
        let parsed;
        try { parsed = parseConfig(raw, resp.ContentType); }
        catch { parsed = raw; }

        this.#configsCache[name] = {
          raw, parsed,
          contentType: resp.ContentType || "text/plain",
          version: resp.ConfigurationVersion ?? null,
          updatedAt: new Date().toISOString()
        };
        this.emit("update", { profile: name, item: this.#configsCache[name] });
      }
    }
  }
}

