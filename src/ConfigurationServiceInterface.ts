export interface ConfigurationServiceInterface {

  /** Set the configuration prefix
   * This prefix will be added to all configuration keys.
   * @param prefix - The prefix to set.
   */
  setConfigPrefix(prefix: string): void;

  /**
   * Returns an array of all configuration objects.
   * This method may perform asynchronous operations such as fetching from a remote source.
   * @returns any[]
   */
  getConfigs(): any[]

  /**
   * Retrieves a configuration value by its name.
   * If the configuration is not found, returns the provided default value.
   * @param name - The name/key of the configuration to retrieve.
   * @param defaultValue - The value to return if the configuration is not found.
   * @returns The configuration value or the default value.
   */
  getConfig(name: string, defaultValue: any): any;

  /**
   * Initializes the configuration service and starts any required background tasks (e.g., polling).
   * This method must be called before using other methods.
   * @returns Promise that resolves when initialization is complete.
   */
  start(): Promise<void>;

  /**
   * Closes the configuration service, stopping any background tasks and releasing resources.
   * This method should be called when the service is no longer needed.
   */
  close(): void;
}
