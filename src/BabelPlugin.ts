import type {
  HeftConfiguration,
  HeftSession,
  IBuildStageContext,
  IBuildStageProperties,
  ICleanStageContext,
  ICompileSubstage,
  IHeftPlugin,
  IScopedLogger,
  ScopedLogger
} from '@rushstack/heft';
import { ConfigurationFile } from '@rushstack/heft-config-file';
import { JsonSchema } from '@rushstack/node-core-library';
import path from 'path';
import { BabelProcessor, IBabelConfiguration } from './BabelProcessor.js';

export interface IBabelConfigurationJson extends IBabelConfiguration {}

const PLUGIN_NAME: string = 'BabelPlugin';
const PLUGIN_SCHEMA_PATH: string = `${__dirname}/schemas/heft-babel-plugin.schema.json`;
const BABEL_CONFIGURATION_LOCATION: string = 'config/babel.json';

export class BabelPlugin implements IHeftPlugin {
  static #babelConfigurationLoader: ConfigurationFile<IBabelConfigurationJson> | undefined;

  public pluginName: string = PLUGIN_NAME;
  public optionsSchema: JsonSchema = JsonSchema.fromFile(PLUGIN_SCHEMA_PATH);
  public accessor?: object | undefined;

  public apply(
    heftSession: HeftSession,
    heftConfiguration: HeftConfiguration,
    options?: void | undefined
  ): void {
    const logger: ScopedLogger = heftSession.requestScopedLogger('Babel Plugin');

    this.#removeTap(heftSession.hooks.build.taps, 'typescript');
    this.#removeTap(heftSession.hooks.clean.taps, 'typescript');

    heftSession.hooks.build.tap(PLUGIN_NAME, (build: IBuildStageContext) => {
      this.#removeTap(build.hooks.compile.taps, 'typescript');

      build.hooks.compile.tap(PLUGIN_NAME, (compile: ICompileSubstage) => {
        this.#removeTap(compile.hooks.run.taps, 'typescript');

        compile.hooks.run.tapPromise(PLUGIN_NAME, async () => {
          await this.#runBabelAsync(heftConfiguration, build.properties, logger);
        });
      });
    });

    heftSession.hooks.clean.tap(PLUGIN_NAME, (clean: ICleanStageContext) => {
      this.#removeTap(clean.hooks.loadStageConfiguration.taps, 'typescript');

      clean.hooks.loadStageConfiguration.tapPromise(PLUGIN_NAME, async () => {
        const configuration: IBabelConfiguration = await this.#loadBabelConfigurationAsync(
          heftConfiguration,
          logger
        );

        if (configuration.emitFolderNameForTests) {
          clean.properties.pathsToDelete.add(
            path.resolve(heftConfiguration.buildFolder, configuration.emitFolderNameForTests)
          );
        }
      });
    });
  }

  async #runBabelAsync(
    heftConfiguration: HeftConfiguration,
    buildProperties: IBuildStageProperties,
    logger: ScopedLogger
  ): Promise<void> {
    const { buildFolder } = heftConfiguration;
    const babelConfiguration: IBabelConfiguration = await this.#loadBabelConfigurationAsync(
      heftConfiguration,
      logger
    );
    const babelCompiler: BabelProcessor = new BabelProcessor({
      buildFolder,
      babelConfiguration,
      logger
    });

    buildProperties.emitFolderNameForTests = babelCompiler.configuration.emitFolderNameForTests;
    buildProperties.emitExtensionForTests = '.js';

    if (!buildProperties.watchMode) {
      const failedFiles: string[] = await babelCompiler.transformAsync();

      if (failedFiles.length > 0) {
        throw new Error(`Encountered Babel error${failedFiles.length > 1 ? 's' : ''}`);
      }
    } else {
      try {
        babelCompiler.runWatcherAsync().catch((e: Error) => logger.emitError(e));
      } catch (e) {
        logger.emitError(e as Error);
      }
    }
  }

  async #loadBabelConfigurationAsync(
    heftConfiguration: HeftConfiguration,
    logger: IScopedLogger
  ): Promise<IBabelConfiguration> {
    logger.terminal.writeVerboseLine(
      `Looking for babel configuration file at ${BABEL_CONFIGURATION_LOCATION}`
    );

    const { buildFolder } = heftConfiguration;
    const babelConfigurationJson: IBabelConfigurationJson | undefined =
      await BabelPlugin.#getBabelConfigurationLoader().tryLoadConfigurationFileForProjectAsync(
        logger.terminal,
        buildFolder,
        heftConfiguration.rigConfig
      );

    if (babelConfigurationJson) {
      if (babelConfigurationJson.srcFolder) {
        babelConfigurationJson.srcFolder = path.resolve(buildFolder, babelConfigurationJson.srcFolder);
      }
    }

    return {
      ...babelConfigurationJson
    };
  }

  #removeTap(taps: { name: string }[], key: string): void {
    const tapIndex: number = taps.findIndex((tap) => tap.name === key);

    if (tapIndex === -1) {
      return;
    }

    taps.splice(tapIndex, 1);
  }

  static #getBabelConfigurationLoader(): ConfigurationFile<IBabelConfigurationJson> {
    if (!BabelPlugin.#babelConfigurationLoader) {
      BabelPlugin.#babelConfigurationLoader = new ConfigurationFile<IBabelConfigurationJson>({
        projectRelativeFilePath: BABEL_CONFIGURATION_LOCATION,
        jsonSchemaPath: PLUGIN_SCHEMA_PATH
      });
    }

    return BabelPlugin.#babelConfigurationLoader;
  }
}
