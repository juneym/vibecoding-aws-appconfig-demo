import { EventEmitter } from "node:events";
import {
  AppConfigClient,
  ListConfigurationProfilesCommand,
} from "@aws-sdk/client-appconfig";
import {
  AppConfigDataClient,
  StartConfigurationSessionCommand,
  GetLatestConfigurationCommand,
  ResourceNotFoundException
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
    #discoveryTimer?: NodeJS.Timeout;
    #tokens = new Map<string, string>();
    #hashes = new Map<string, string>();
    #closed = false;
    #configPrefix: string = "";

    /** { [profileName]: { raw, parsed, contentType, version, updatedAt } } */
    #configsCache: Record<string, any> = {};

    /**
     * Sets the configuration prefix.
     * This prefix will be added to all configuration keys.
     * @param prefix - The prefix to set.
     */
    setConfigPrefix(prefix: string): void {
        this.#configPrefix = prefix;
    }

    getConfigs(): Record<string, any> {
        return { ...this.#configsCache };
    }

    /**
     * Retrieves a parsed configuration value by its name.
     *
     * This method prepends the configured prefix (if any) to the requested configuration name
     * before looking it up in the internal cache. If the configuration is found, its parsed
     * value is returned. Otherwise, the provided default value is returned.
     *
     * @param name - The name of the configuration to retrieve.
     * @param defaultValue - The value to return if the configuration is not found.
     * @returns The parsed configuration value, or the default value if not found.
     */
    getConfig(name: string, defaultValue: any): any {

        let realConfigName = `${this.#configPrefix}${name}`;
        if (realConfigName in this.#configsCache) {
            return this.#configsCache[realConfigName].parsed;
        }
        return defaultValue;
    }

    /**
     * Constructs an instance of the AWSAppConfig class.
     * @param opts - The options for the configuration service.
     * @param opts.applicationId - The ID of the application.
     * @param opts.environmentId - The ID of the environment.
     * @param opts.region - The AWS region.
     * @param opts.pollIntervalMs - The polling interval in milliseconds for configuration values
     * @param opts.discoveryIntervalMs - The discovery interval in milliseconds for configuration profiles
     */
    constructor(opts: { applicationId: string; environmentId: string; region: string; pollIntervalMs?: number, discoveryIntervalMs?: number }) {
        super();
        if (!opts?.applicationId || !opts?.environmentId || !opts?.region) {
            throw new Error("applicationId, environmentId, and region are required");
        }
        // Default discovery interval to 5 minutes
        this.#opts = { pollIntervalMs: 30000, discoveryIntervalMs: 300000, ...opts };
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
        const profiles = await this.#discoverProfiles();
        
        // Start periodic discovery
        this.#discoveryTimer = setInterval(() => this.#discoverProfiles(), this.#opts.discoveryIntervalMs);
        this.emit("ready", { profiles: profiles.map(p => p.Name) });
    }

    /**
     * Closes the configuration service by clearing all timers, tokens and hashes.
     * This will prevent new polling requests from being scheduled.
     * @returns {void}
     */
    close(): void {
        this.#closed = true;
        if (this.#discoveryTimer) clearInterval(this.#discoveryTimer);
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
     * Discovers and starts polling for new configuration profiles.
     * It lists profiles from AWS AppConfig, filters them based on the prefix,
     * and starts polling for any new profiles not already being tracked.
     *
     * @private
     * @returns {Promise<any[]>} A promise that resolves with the list of profiles found in this discovery cycle.
     */
    async #discoverProfiles(): Promise<any[]> {
        this.emit("debug", { message: "Discovering configuration profiles..." });
        try {
            let profiles = await this.#listProfiles();

            if (this.#configPrefix) {
                profiles = profiles.filter(p => p.Name?.startsWith(this.#configPrefix));
            }

            const newProfiles = profiles.filter(p => p.Name && !this.#timers.has(p.Name));

            if (newProfiles.length > 0) {
                this.emit("debug", { message: `Found ${newProfiles.length} new profiles to track.` });
                await Promise.all(newProfiles.map(p => this.#startProfile(p)));
            }
            return profiles;
        } catch (err) {
            this.emit("error", { type: "error", profile: "discovery", error: err });
            return [];
        }
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
     * Stops polling for a given profile and cleans up its resources.
     * @param profile - The configuration profile to stop.
     */
    #stopProfile(profile: any): void {
        const profileName = profile.Name;
        if (!profileName) return;

        const timer = this.#timers.get(profileName);
        if (timer) clearTimeout(timer);
        this.#timers.delete(profileName);
        this.#tokens.delete(profileName);
        this.#hashes.delete(profileName);
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
                const currentHash = this.#hashes.get(profile.Name);

                if (hash !== currentHash) {
                    const config = {
                        parsed: parseConfig(raw, res.ContentType),
                        contentType: res.ContentType,
                        // @ts-ignore
                        version: res.VersionNumber,
                        updatedAt: new Date(),
                    };
                    // Atomically update caches only after successful processing
                    this.#hashes.set(profile.Name, hash);
                    this.#configsCache[profile.Name] = config;
                    this.emit("update", { type: "update", profile: profile.Name, config: config.parsed });
                }
            }
            if (res.NextPollConfigurationToken) {
                this.#tokens.set(profile.Name, res.NextPollConfigurationToken);
            }
        } catch (err) {
            if (err instanceof ResourceNotFoundException) {
                this.emit("profile_deleted", { type: "profile_deleted", profile: profile.Name, error: err });
                this.#stopProfile(profile);
                return; // Stop further processing for this profile
            }
            this.emit("error", { type: "error", profile: profile.Name, error: err });
        }
        this.#timers.set(
            profile.Name,
            setTimeout(() => this.#pollOnce(profile), this.#opts.pollIntervalMs)
        );
    }
}
