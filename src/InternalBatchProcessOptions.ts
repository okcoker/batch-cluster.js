import { BatchClusterOptions, WithObserver } from './BatchClusterOptions.ts';
import { BatchProcessOptions } from './BatchProcessOptions.ts';

export interface InternalBatchProcessOptions
	extends BatchProcessOptions, BatchClusterOptions, WithObserver {
	passRE: RegExp;
	failRE: RegExp;
	onProcessExit?: () => void
}
