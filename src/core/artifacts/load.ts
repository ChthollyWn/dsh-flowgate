/**
 * Artifact file locations and loading.
 *
 * `root` is the managed project root; files live under `<root>/.flowgate/`.
 * Per-change paths are delegated to `src/core/store/layout.ts` (single source of
 * truth, shared with the engine).
 */
import type {
  ArtifactBundle,
  ArtifactName,
  ClarifyDoc,
  ProjectDoc,
  RoadmapDoc,
} from '../types'
import type { FileSystem } from '../util/fs'
import { sha256 } from '../util/hash'
import { normalizeRelPath, posixJoin } from '../util/paths'
import { changePaths as storeChangePaths, type ChangePaths } from '../store/layout'

/** Artifacts written per change (project.md and roadmap.md are project-level). */
export const CHANGE_ARTIFACTS: ArtifactName[] = ['clarify', 'proposal', 'spec', 'context', 'design', 'risk', 'tasks']
import {
  parseClarify,
  parseContext,
  parseDesign,
  parseIncrementalSpec,
  parseProjectDoc,
  parseProposal,
  parseRisk,
  parseRoadmap,
  parseTasks,
} from './parse'

/** Per-change paths are owned by the store layout; re-exported here for convenience. */
export type { ChangePaths }

/** Resolve every per-change artifact path (repo-relative when `root` is empty). */
export function changePaths(root: string, changeId: string): ChangePaths {
  return storeChangePaths(root, changeId)
}

function flowgateDir(root: string): string {
  return normalizeRelPath(root) === '' ? '.flowgate' : posixJoin(root, '.flowgate')
}

async function readOptional(fs: FileSystem, path: string): Promise<string | null> {
  try {
    if (!(await fs.exists(path))) return null
    return await fs.readFile(path)
  } catch {
    return null
  }
}

/** Load and parse every artifact of a change; missing files stay `undefined`. */
export async function loadArtifacts(fs: FileSystem, root: string, changeId: string): Promise<ArtifactBundle> {
  const paths = changePaths(root, changeId)
  const bundle: ArtifactBundle = {}
  const [clarify, proposal, spec, context, design, risk, tasks] = await Promise.all([
    readOptional(fs, paths.clarify),
    readOptional(fs, paths.proposal),
    readOptional(fs, paths.spec),
    readOptional(fs, paths.context),
    readOptional(fs, paths.design),
    readOptional(fs, paths.risk),
    readOptional(fs, paths.tasks),
  ])
  if (clarify !== null) bundle.clarify = parseClarify(clarify)
  if (proposal !== null) bundle.proposal = parseProposal(proposal)
  if (spec !== null) bundle.spec = parseIncrementalSpec(spec)
  if (context !== null) bundle.context = parseContext(context)
  if (design !== null) bundle.design = parseDesign(design)
  if (risk !== null) bundle.risk = parseRisk(risk)
  if (tasks !== null) bundle.tasks = parseTasks(tasks)
  return bundle
}

/** Load `.flowgate/project.md`; returns null when it does not exist. */
export async function loadProjectDoc(fs: FileSystem, root: string): Promise<ProjectDoc | null> {
  const path = posixJoin(flowgateDir(root), 'project.md')
  const raw = await readOptional(fs, path)
  return raw === null ? null : parseProjectDoc(raw)
}

/** Load `.flowgate/roadmap.md`; returns null when it does not exist. */
export async function loadRoadmap(fs: FileSystem, root: string): Promise<RoadmapDoc | null> {
  const path = posixJoin(flowgateDir(root), 'roadmap.md')
  const raw = await readOptional(fs, path)
  return raw === null ? null : parseRoadmap(raw)
}

/** Read the raw project-clarify document used by GR checks (null when absent). */
export async function loadProjectClarifyRaw(fs: FileSystem, root: string): Promise<string | null> {
  return readOptional(fs, posixJoin(flowgateDir(root), 'project-clarify.md'))
}

/** sha256 of every loaded artifact's raw file content, keyed by ArtifactName. */
export function artifactHashes(bundle: ArtifactBundle): Record<string, string> {
  const hashes: Record<string, string> = {}
  for (const name of Object.keys(bundle) as ArtifactName[]) {
    const artifact = bundle[name]
    if (!artifact || typeof (artifact as { raw?: unknown }).raw !== 'string') continue
    hashes[name] = sha256((artifact as { raw: string }).raw)
  }
  return hashes
}

export type { ClarifyDoc }
