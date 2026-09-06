/** @module @ephemeral-ai/mayfly/jobs */
export {
  name, inject, apply, JOB_STATUS_MARKS, JOB_OUTPUT_TAIL_LINES,
  isLiveJob, sortJobs, formatJobDuration, tailJobOutput, jobsPanelModel, jobOutputPanelModel,
} from './interaction/jobs.ts'
