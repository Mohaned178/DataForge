import { buildRunFiles, parseScenario, simulate, type RunFiles, type SimulationResult } from '@dataforge/core';

/** A generated run: the simulation result and the four run files built from it. */
export interface GeneratedRun {
  readonly result: SimulationResult;
  readonly files: RunFiles;
}

/** What the runner needs to know about a stored run to generate it. */
export interface RunInputs {
  readonly definition: unknown;
  readonly scenarioHash: string;
  readonly seed: string;
}

export type RunGenerator = (inputs: RunInputs) => GeneratedRun;

/**
 * Generates a stored run exactly as "dataforge generate" would: the stored resolved definition is
 * parsed again (it must still be a valid scenario with the recorded hash) and simulated with the seed.
 */
export const generateRun: RunGenerator = ({ definition, scenarioHash, seed }) => {
  const scenario = parseScenario(definition);
  const result = simulate({ scenario, seed });
  if (result.scenarioHash !== scenarioHash) {
    throw new Error(`the stored scenario definition hashes to ${result.scenarioHash}, but its version records ${scenarioHash}`);
  }
  return { result, files: buildRunFiles(scenario, result) };
};
