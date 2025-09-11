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
import { ConfigurationServiceInterface } from "../ConfigurationServiceInterface";

const textDecoder = new TextDecoder();

function parseConfig(raw: string, contentType?: string): any {
  const ct = (contentType || "").toLowerCase();

  if (ct.includes("json")) 
    return JSON.parse(raw);

  if (ct.includes("yaml") || ct.includes("yml")) 
    return yaml.load(raw);

  try { return JSON.parse(raw); } catch { return raw; }
}

function stableHash(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
  return (h >>> 0).toString(16);
}

export class AWSAppConfig extends EventEmitter implements ConfigurationServiceInterface {
    #control: AppConfigClient;
    #data: AppConfigDataClient;
    #opts: any;
    #timers = new Map<string, NodeJS.Timeout>();
    #tokens = new Map<string, string>();
    #hashes = new Map<string, string>();
    #closed = false;

    /** { [profileName]: { raw, parsed, contentType, version, updatedAt } } */
    #configsCache: Record<string, any> = {};

    getConfigs(): any[] {
        return Object.values(this.#configsCache);
    }

    getConfig(name: string, defaultValue: any): any {
        if (name in this.#configsCache) {
            return this.#configsCache[name].parsed;
        }
        return defaultValue;
    }

    constructor(opts: { applicationId: string; environmentId: string; region: string; pollIntervalMs?: number }) {
        super();
        if (!opts?.applicationId || !opts?.environmentId || !opts?.region) {
            throw new Error("applicationId, environmentId, and region are required");
        }
        this.#opts = { pollIntervalMs: 30000, ...opts };
        this.#control = new AppConfigClient({ region: this.#opts.region });
        this.#data = new AppConfigDataClient({ region: this.#opts.region });
    }

    /**
     * Initializes the configuration service by starting all available profiles.
     * This method retrieves all profiles and starts them concurrently.
     * 
     * @throws {Error} If there's an error retrieving profiles or starting any profile
     * @returns {Promise<void>} A promise that resolves when all profiles have been started
     */
    async start(): Promise<void> {
        const profiles = await this.#listProfiles();
        await Promise.all(profiles.map(p => this.#startProfile(p)));
    }

    /**
     * Closes the configuration service by clearing all timers, tokens and hashes.
     * This will prevent new polling requests from being scheduled.
     * @returns {void}
     */
    close(): void {
        this.#closed = true;
        for (const timer of this.#timers.values()) clearTimeout(timer);
        this.#timers.clear();
        this.#tokens.clear();
        this.#hashes.clear();
    }

    /**
     * Fetches all configuration profiles for the application from AWS AppConfig.
     *
     * This method handles pagination by repeatedly requesting profiles until all are retrieved.
     * It accumulates the profiles in an array and returns them. Each profile object typically
     * contains metadata such as Id, Name, and other properties defined by AppConfig.
     *
     * @private
     * @returns {Promise<any[]>} Promise resolving to an array of profile objects.
     */
    async #listProfiles(): Promise<any[]> {
        const cmd = new ListConfigurationProfilesCommand({
            ApplicationId: this.#opts.applicationId
        });
        const res = await this.#control.send(cmd);
        return res.Items || [];
    }

    /**
     * Initializes a configuration session for a given profile in AWS AppConfig.
     *
     * This method sends a StartConfigurationSessionCommand to AWS AppConfig using the application's
     * identifiers and the profile's Id. If the profile does not have the required Id or Name properties,
     * it throws an error. If the session cannot be started (no InitialConfigurationToken is returned),
     * it logs a warning and skips the profile. Otherwise, it stores the token for future polling.
     *
     * @private
     * @param profile - The configuration profile object, expected to have Id and Name properties.
     * @returns {Promise<void>}
     * @throws {Error} If the profile is missing required properties or if the session cannot be started.
     */
    async #startProfile(profile: any): Promise<void> {
        const cmd = new StartConfigurationSessionCommand({
            ApplicationIdentifier: this.#opts.applicationId,
            ConfigurationProfileIdentifier: profile.Id,
            EnvironmentIdentifier: this.#opts.environmentId
        });
        const res = await this.#data.send(cmd);
        if (!res.InitialConfigurationToken) throw new Error("No token");
        this.#tokens.set(profile.Name, res.InitialConfigurationToken);
        await this.#pollOnce(profile);
    }

    /**
     * Polls AWS AppConfig for configuration updates for a specific profile.
     * 
     * @private
     * @param profile - The configuration profile containing Name and other properties
     * @throws {Error} When no token is available for the profile
     * @emits update - When new configuration is detected and parsed
     * @emits error - When an error occurs during polling
     * 
     * This method:
     * 1. Fetches the latest configuration using stored token
     * 2. Decodes and parses new configuration if available
     * 3. Caches the configuration and notifies listeners on changes
     * 4. Updates tokens for next polling cycle
     * 5. Schedules next poll based on configured interval
     */
    async #pollOnce(profile: any): Promise<void> {

        this.emit("debug", {message: `Polling config profile: ${profile.Name} at ${new Date().toISOString()}`});

        if (this.#closed) return;
        try {
            const token = this.#tokens.get(profile.Name);
            if (!token) throw new Error("No token");
            const cmd = new GetLatestConfigurationCommand({ ConfigurationToken: token });
            const res = await this.#data.send(cmd);

            if (!res.Configuration) return;

            const raw = textDecoder.decode(res.Configuration);
            if (typeof raw === "string" && raw.trim() !== "") {
                const hash = stableHash(raw);
                if (hash !== this.#hashes.get(profile.Name)) {
                    this.#hashes.set(profile.Name, hash);
                    const config = {
                        raw,
                        parsed: parseConfig(raw, res.ContentType),
                        contentType: res.ContentType,
                        // @ts-ignore
                        version: res.VersionNumber,
                        updatedAt: new Date()
                    };
                    this.#configsCache[profile.Name] = config;
                    this.emit("update", { type: "update", profile: profile.Name, config });
                }
            }
            if (res.NextPollConfigurationToken) {
                this.#tokens.set(profile.Name, res.NextPollConfigurationToken);
            }
        } catch (err) {
            this.emit("error", { type: "error", profile: profile.Name, error: err });
        }
        this.#timers.set(
            profile.Name,
            setTimeout(() => this.#pollOnce(profile), this.#opts.pollIntervalMs)
        );
    }
}
