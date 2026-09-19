/**
 * Cross-validation of computational results from multiple solution methods.
 * Pure TypeScript — no external dependencies.
 */

export interface MethodResult {
  method_name: string;
  target_value: string; // exact symbolic value (e.g., "14/5")
  target_decimal: number;
  valid_roots?: string[]; // roots that passed validation
  details?: Record<string, string>; // method-specific details
}

export interface CrossValidationResult {
  methods_agree: boolean;
  final_answer: string;
  final_answer_decimal: number;
  confidence: number;
  max_discrepancy: number;
  method_results: MethodResult[];
  discrepancy_detail?: string;
}

const DEFAULT_TOLERANCE = 1e-6;

/**
 * Cross-validate results from multiple solution methods.
 *
 * Strategy:
 * - Compare target_decimal values across all methods
 * - If all agree within tolerance → high confidence
 * - If some disagree → report discrepancy, lower confidence
 * - For equation-solving: also check root sets for consistency
 */
export function crossValidateMethods(
  results: MethodResult[],
  tolerance: number = DEFAULT_TOLERANCE,
): CrossValidationResult {
  if (results.length === 0) {
    return {
      methods_agree: false,
      final_answer: "",
      final_answer_decimal: NaN,
      confidence: 0,
      max_discrepancy: Infinity,
      method_results: [],
    };
  }

  if (results.length === 1) {
    return {
      methods_agree: true,
      final_answer: results[0].target_value,
      final_answer_decimal: results[0].target_decimal,
      confidence: 0.5, // single method → moderate confidence
      max_discrepancy: 0,
      method_results: results,
    };
  }

  // Compare all pairs
  const decimals = results.map((r) => r.target_decimal);
  let maxDiscrepancy = 0;
  for (let i = 0; i < decimals.length; i++) {
    for (let j = i + 1; j < decimals.length; j++) {
      const diff = Math.abs(decimals[i] - decimals[j]);
      maxDiscrepancy = Math.max(maxDiscrepancy, diff);
    }
  }

  const methodsAgree = maxDiscrepancy < tolerance;

  // If methods agree, use the first result's exact value
  // If they disagree, still use the first but flag it
  const primary = results[0];

  // Confidence calculation:
  // - 2+ methods agreeing → 1.0
  // - 3+ methods agreeing → 1.0
  // - Methods disagreeing → proportion that agree with majority
  let confidence: number;
  if (methodsAgree) {
    confidence = 1.0;
  } else {
    // Find the majority cluster
    const clusters = clusterValues(decimals, tolerance);
    const largestCluster = clusters.reduce((a, b) =>
      a.length >= b.length ? a : b,
    );
    confidence = largestCluster.length / decimals.length;
  }

  // Root set cross-check (if available)
  let discrepancyDetail: string | undefined;
  if (!methodsAgree) {
    const details = results.map(
      (r) => `${r.method_name}: ${r.target_value} (≈${r.target_decimal})`,
    );
    discrepancyDetail = `方法结果不一致:\n${details.join("\n")}`;
  }

  // Vieta cross-check: if we have explicit roots and a Vieta sum
  const vietaResult = results.find((r) => r.method_name === "vieta");
  const explicitResult = results.find((r) => r.method_name === "explicit_solve");

  if (vietaResult && explicitResult?.valid_roots) {
    const rootSum = explicitResult.valid_roots.reduce((acc, root) => {
      // Try to parse as decimal for comparison
      const val = parseFloat(root);
      return acc + (isNaN(val) ? 0 : val);
    }, 0);
    const vietaDecimal = vietaResult.target_decimal;
    const crossCheckDiff = Math.abs(rootSum - vietaDecimal);
    if (crossCheckDiff > tolerance) {
      discrepancyDetail =
        (discrepancyDetail ?? "") +
        `\n根集交叉检查: 有效根之和(${rootSum}) ≠ Vieta根之和(${vietaDecimal})`;
    }
  }

  return {
    methods_agree: methodsAgree,
    final_answer: primary.target_value,
    final_answer_decimal: primary.target_decimal,
    confidence,
    max_discrepancy: maxDiscrepancy,
    method_results: results,
    discrepancy_detail: discrepancyDetail,
  };
}

/**
 * Cluster numeric values into groups where all members are within tolerance.
 */
function clusterValues(values: number[], tolerance: number): number[][] {
  const used = new Set<number>();
  const clusters: number[][] = [];

  for (let i = 0; i < values.length; i++) {
    if (used.has(i)) continue;
    const cluster = [values[i]];
    used.add(i);
    for (let j = i + 1; j < values.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(values[i] - values[j]) < tolerance) {
        cluster.push(values[j]);
        used.add(j);
      }
    }
    clusters.push(cluster);
  }

  return clusters;
}
