/**
 * A Heft plugin for using babel during the "build" stage.
 *
 * @packageDocumentation
 */

import type { IHeftPlugin } from '@rushstack/heft';
import { BabelPlugin } from './BabelPlugin';

/**
 * @public
 */
export default new BabelPlugin() as IHeftPlugin;
