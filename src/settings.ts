/** Must match the `pluginAlias` in config.schema.json. */
export const PLATFORM_NAME = 'Mq77Customizer';

/** Must match the `name` in package.json. */
export const PLUGIN_NAME = 'homebridge-mq77-customizer';

/** Subdirectory of the Homebridge storage path holding our persisted state. */
export const STORAGE_DIR = 'mq77-customizer';

/**
 * Where state lived before the plugin was renamed from MQTT Customizer.
 *
 * Adopted once if the current file is missing, so a rename does not silently
 * throw away every function the user had ticked.
 */
export const LEGACY_STORAGE_DIR = 'mqtt-customizer';
