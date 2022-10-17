import {
  BabelFileResult,
  loadPartialConfigAsync,
  PartialConfig,
  transformAsync,
  TransformOptions
} from '@babel/core';
import { IScopedLogger } from '@rushstack/heft';
import { Async, FileSystem, LegacyAdapters, NewlineKind, Path } from '@rushstack/node-core-library';
import * as chokidar from 'chokidar';
import glob from 'glob';
import path, { ParsedPath } from 'path';

/**
 * @public
 */
export interface IBabelConfiguration {
  /**
   * Source code root directory.
   * Defaults to "src/".
   */
  srcFolder?: string;

  /**
   * Output code root directory.
   * Defaults to "lib/".
   */
  outFolder?: string;

  /**
   * Files with these extensions will pass through the Babel compiler.
   * Defaults to [".js"]
   */
  fileExtensions?: string[];

  /**
   * Output file extension
   * Defaults to ".js"
   */
  outputFileExtension?: string;

  /**
   * Specifies the intermediary folder that tests will use.  Because Jest uses the
   * Node.js runtime to execute tests, the module format must be CommonJS.
   *
   * The default value is "lib-commonjs".
   */
  emitFolderNameForTests?: string;
}

/**
 * @pubilc
 */
export interface IBabelCompilerOptions {
  buildFolder: string;
  babelConfiguration: IBabelConfiguration;
  logger: IScopedLogger;
}

const BABEL_CONFIGURATION_FILES: string[] = [
  'babel.config.js',
  'babel.config.json',
  'babel.config.cjs',
  'babel.config.mjs'
];

/**
 * Transform source files.
 *
 * @public
 */
export class BabelProcessor {
  #buildFolder: string;
  #babelConfiguration: Required<IBabelConfiguration>;
  #sourceFolderPath: string;
  #outputFolderPath: string;
  #outputFolderPathForTests: string;
  #inputFileGlob: string;
  #ignoredFileGlob: string | undefined;
  #logger: IScopedLogger;
  #transformOptions: TransformOptions;

  public constructor(options: IBabelCompilerOptions) {
    this.#buildFolder = options.buildFolder;
    this.#babelConfiguration = {
      srcFolder: 'src/',
      outFolder: 'lib/',
      outputFileExtension: '.js',
      emitFolderNameForTests: 'lib-commonjs',
      fileExtensions: ['.js'],
      ...options.babelConfiguration
    };
    this.#babelConfiguration.fileExtensions = BabelProcessor.#normalizeFileExtensions(
      this.#babelConfiguration.fileExtensions
    );
    this.#sourceFolderPath = path.resolve(options.buildFolder, this.#babelConfiguration.srcFolder);
    this.#outputFolderPath = path.resolve(options.buildFolder, this.#babelConfiguration.outFolder);
    this.#outputFolderPathForTests = path.resolve(
      options.buildFolder,
      this.#babelConfiguration.emitFolderNameForTests
    );
    this.#inputFileGlob = `**/*+(${this.#babelConfiguration.fileExtensions.join('|')})`;
    this.#ignoredFileGlob = undefined;
    this.#logger = options.logger;
    this.#transformOptions = {
      root: this.#buildFolder,
      cwd: this.#buildFolder
    };
  }

  public get configuration(): Required<IBabelConfiguration> {
    return this.#babelConfiguration;
  }

  public get sourceFolder(): string {
    return this.#sourceFolderPath;
  }

  public get outputFolder(): string {
    return this.#outputFolderPath;
  }

  public async transformAsync(filePaths?: string[]): Promise<string[]> {
    if (!filePaths?.length) {
      filePaths = await LegacyAdapters.convertCallbackToPromise(glob, this.#inputFileGlob, {
        cwd: this.sourceFolder,
        ignore: this.#ignoredFileGlob,
        nosort: true,
        nodir: true
      });
    }

    return await this.#reprocessFilesAsync(filePaths);
  }

  public async runWatcherAsync(): Promise<void> {
    await new Promise((resolve, reject) => {
      const watcher: chokidar.FSWatcher = chokidar.watch(
        [
          this.#inputFileGlob,
          ...BABEL_CONFIGURATION_FILES.map((babelConfigFile: string): string => {
            return path.resolve(this.#buildFolder, babelConfigFile);
          })
        ],
        {
          cwd: this.sourceFolder,
          ignored: this.#outputFolderPath,
          ignoreInitial: true
        }
      );
      const queue: Set<string> = new Set();

      let timeout: NodeJS.Timeout | undefined;
      let processing: boolean = false;
      let flushAfterCompletion: boolean = false;
      let configFileChanged: boolean = false;
      let isFirstEmit: boolean = true;

      const flushInternal: () => void = () => {
        if (isFirstEmit) {
          isFirstEmit = false;
          this.#logger.terminal.writeLine(`Starting compilation in watch mode...`);
        } else {
          this.#logger.terminal.writeLine(`File change detected. Starting incremental compilation...`);
        }

        processing = true;

        let reprocessPromise: Promise<string[]>;

        if (!configFileChanged && queue.size > 0) {
          const sourceFilePahtsToProcess: string[] = Array.from(queue);
          queue.clear();

          reprocessPromise = this.#reprocessFilesAsync(sourceFilePahtsToProcess);
        } else {
          configFileChanged = false;
          reprocessPromise = this.transformAsync();
        }

        reprocessPromise
          .then((failedFiles: string[]) => {
            const errorCount: number = failedFiles.length;

            processing = false;

            this.#logger.terminal.writeLine(
              `Found ${errorCount} error${errorCount > 1 ? 's' : ''}. Watching for file changes.`
            );

            for (const failedFile of failedFiles) {
              queue.add(failedFile);
            }

            if (flushAfterCompletion) {
              flushAfterCompletion = false;
              flushInternal();
            }
          })
          .catch(reject);
      };

      const debounceFlush: () => void = () => {
        timeout = undefined;

        if (processing) {
          flushAfterCompletion = true;
          return;
        }

        flushInternal();
      };

      const onChange: (type: string, relativePath: string) => void = (type: string, relativePath: string) => {
        if (this.#isBabelConfigurationFile(path.resolve(this.sourceFolder, relativePath))) {
          this.#logger.terminal.writeVerboseLine(`Babel config file change detected: ${relativePath}`);

          configFileChanged = true;
          queue.clear();
        } else {
          this.#logger.terminal.writeVerboseLine(`Source file change detected: ${relativePath}`);

          if (!configFileChanged) {
            queue.add(relativePath);
          }
        }

        if (timeout) {
          clearTimeout(timeout);
        }

        setTimeout(debounceFlush, 500);
      };

      watcher.on('add', onChange.bind(null, 'add'));
      watcher.on('change', onChange.bind(null, 'change'));
      watcher.on('unlink', async (relativePath: string) => {
        const resolvedFilePath: string = path.resolve(this.sourceFolder, relativePath);

        if (this.#isBabelConfigurationFile(resolvedFilePath)) {
          onChange('unlink', relativePath);
          return;
        }

        await Promise.all(
          this.#getOutputFilePaths(relativePath, this.#outputFolderPath).map(async (outputPath: string) => {
            if (await FileSystem.existsAsync(outputPath)) {
              await FileSystem.deleteFileAsync(outputPath);
            }
          })
        );
      });
      watcher.on('error', reject);

      flushInternal();
    });
  }

  async #reprocessFilesAsync(rawRelativeSourceFilePaths: string[]): Promise<string[]> {
    const resolvedSourceFilePaths: Set<string> = new Set();
    const filePathMapResolvedToRelative: Map<string, string> = new Map();

    for (const rawRelativeSourceFilePath of rawRelativeSourceFilePaths) {
      const relativeSourceFilePath: string = Path.convertToSlashes(rawRelativeSourceFilePath);
      const resolvedSourceFilePath: string = path.resolve(this.sourceFolder, rawRelativeSourceFilePath);

      filePathMapResolvedToRelative.set(resolvedSourceFilePath, relativeSourceFilePath);
      resolvedSourceFilePaths.add(resolvedSourceFilePath);
    }

    if (!resolvedSourceFilePaths.size) {
      this.#logger.terminal.writeLine('Nothing to build');
      return [];
    }

    const resolvedFilePathForFailedFiles: string[] = [];
    const transformOptions: TransformOptions = { ...this.#transformOptions };
    const babelPluginTransformModuleCommonJs: string = require.resolve(
      '@babel/plugin-transform-modules-commonjs'
    );

    let options: Readonly<PartialConfig> | null;

    try {
      options = await loadPartialConfigAsync(transformOptions);
    } catch (e) {
      this.#logger.terminal.writeErrorLine(`Error occurred parsing babel configuration: ${e}`);

      return rawRelativeSourceFilePaths;
    }

    if (!options) {
      throw new Error('Error occurred parsing babel transform options');
    }

    await Async.forEachAsync(
      resolvedSourceFilePaths,
      async (resolvedSourceFilePath: string) => {
        try {
          const relativeSourceFilePath: string | undefined =
            filePathMapResolvedToRelative.get(resolvedSourceFilePath);

          if (!relativeSourceFilePath) {
            throw new Error(`Missing relative path for file ${resolvedSourceFilePath}`);
          }

          await this.#transformSourceFile(
            transformOptions,
            resolvedSourceFilePath,
            relativeSourceFilePath,
            this.#getOutputFilePaths(relativeSourceFilePath, this.#outputFolderPath)
          );
          await this.#transformSourceFile(
            {
              ...transformOptions,
              plugins: [babelPluginTransformModuleCommonJs]
            },
            resolvedSourceFilePath,
            relativeSourceFilePath,
            this.#getOutputFilePaths(relativeSourceFilePath, this.#outputFolderPathForTests)
          );
        } catch (error) {
          this.#logger.emitError(error);
          resolvedFilePathForFailedFiles.push(resolvedSourceFilePath);
        }
      },
      { concurrency: 20 }
    );

    return resolvedFilePathForFailedFiles.map((resolvedFilePathForFailedFile: string): string => {
      return path.relative(this.sourceFolder, resolvedFilePathForFailedFile);
    });
  }

  async #transformSourceFile(
    transformOptions: TransformOptions,
    resolvedSourceFilePath: string,
    relativeSourceFilePath: string,
    outputFilePaths: string[]
  ): Promise<void> {
    const fileContents: string = await FileSystem.readFileAsync(resolvedSourceFilePath);
    const result: BabelFileResult | null = await transformAsync(fileContents, {
      ...transformOptions,
      filename: relativeSourceFilePath
    });

    if (!result?.code) {
      return;
    }

    await FileSystem.writeFileAsync(outputFilePaths[0], result.code, {
      ensureFolderExists: true,
      convertLineEndings: NewlineKind.OsDefault
    });

    if (!result.map || !outputFilePaths[1]) {
      return;
    }

    await FileSystem.writeFileAsync(outputFilePaths[1], JSON.stringify(result.map), {
      ensureFolderExists: true,
      convertLineEndings: NewlineKind.OsDefault
    });
  }

  #getOutputFilePaths(relativePath: string, outputFolderPath: string): string[] {
    const result: string[] = [];
    const parsedOutputFilePath: ParsedPath = path.parse(path.resolve(outputFolderPath, relativePath));

    if (parsedOutputFilePath.ext) {
      parsedOutputFilePath.base = parsedOutputFilePath.base.replace(
        new RegExp(`${parsedOutputFilePath.ext}$`),
        this.#babelConfiguration.outputFileExtension
      );
    }

    parsedOutputFilePath.ext = this.#babelConfiguration.outputFileExtension;

    const outputCodeFilePath: string = path.format(parsedOutputFilePath);

    result.push(outputCodeFilePath);
    result.push(`${outputCodeFilePath}.map`);

    return result;
  }

  #isBabelConfigurationFile(resolvedFilePath: string): boolean {
    const relativeFilePath: string = path.relative(this.#buildFolder, resolvedFilePath);

    return BABEL_CONFIGURATION_FILES.includes(relativeFilePath);
  }

  static #normalizeFileExtensions(fileExtensions: string[]): string[] {
    const result: Set<string> = new Set();

    for (const fileExtension of fileExtensions) {
      if (!fileExtension.startsWith('.')) {
        result.add(`.${fileExtension}`);
      } else {
        result.add(fileExtension);
      }
    }

    return Array.from(result);
  }
}
