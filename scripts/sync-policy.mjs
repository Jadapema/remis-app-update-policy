#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

const repository = process.env.REMIS_REPOSITORY ?? 'remisapp/remis-app'
const token = process.env.REMIS_REPO_TOKEN
const runIdOverride = process.env.REMIS_RUN_ID?.trim()
const manualVersion = process.env.RELEASE_VERSION?.trim()
const activate = process.env.ACTIVATE_POLICY === 'true'
const outputPath = path.resolve(
  process.env.POLICY_OUTPUT ?? 'public/mobile-update.json'
)
const policyUrl =
  process.env.POLICY_URL ??
  'https://jadapema.github.io/remis-app-update-policy/mobile-update.json'

const writeOutput = (name, value) => {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
  }
}

if (!manualVersion && !token) {
  writeOutput('changed', 'false')
  writeOutput('release-version', 'not-configured')
  writeOutput('run-id', 'none')
  console.log('Automatic synchronization skipped: REMIS_REPO_TOKEN is not configured')
  process.exit(0)
}

const request = async (endpoint) => {
  if (!token) {
    throw new Error('REMIS_REPO_TOKEN is required for automatic synchronization')
  }

  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })

  if (!response.ok) {
    throw new Error(`GitHub API request failed: ${response.status} ${endpoint}`)
  }

  return response.json()
}

const findAutomaticRelease = async () => {
  const run = runIdOverride
    ? await request(`/repos/${repository}/actions/runs/${runIdOverride}`)
    : (
        await request(
          `/repos/${repository}/actions/workflows/staging.yml/runs?branch=staging&per_page=1`
        )
      ).workflow_runs?.[0]

  if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('The latest staging workflow has not completed successfully')
  }

  const jobsResponse = await request(
    `/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`
  )
  const jobs = jobsResponse.jobs ?? []
  const succeeded = (platform) =>
    jobs.some(
      (job) =>
        job.conclusion === 'success' &&
        job.name.toLowerCase().includes('deploy-beta') &&
        job.name.toLowerCase().includes(platform)
    )

  if (!succeeded('android') || !succeeded('ios')) {
    throw new Error('The latest staging workflow did not deploy both platforms')
  }

  const tags = await request(`/repos/${repository}/tags?per_page=100`)
  const startedAt = Date.parse(run.created_at) - 60_000
  const completedAt = Date.parse(run.updated_at) + 60_000

  for (const tag of tags) {
    const commit = await request(
      `/repos/${repository}/commits/${encodeURIComponent(tag.name)}`
    )
    const committedAt = Date.parse(commit.commit?.committer?.date ?? '')
    const message = commit.commit?.message ?? ''
    const version = message.match(
      /^chore\(release\):\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+\[/
    )?.[1]

    if (
      version &&
      committedAt >= startedAt &&
      committedAt <= completedAt
    ) {
      return {
        releaseVersion: version,
        verifiedAt: new Date(run.updated_at),
        runId: run.id
      }
    }
  }

  throw new Error('No Semantic Release tag was created during the staging run')
}

const parseReleaseVersion = (releaseVersion) => {
  const match = releaseVersion.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
  )

  if (!match) throw new Error(`Invalid release version: ${releaseVersion}`)

  const [, majorRaw, minorRaw, patchRaw, prereleaseRaw] = match
  const major = Number(majorRaw)
  const minor = Number(minorRaw)
  const patch = Number(patchRaw)
  const prereleaseNumber = prereleaseRaw
    ? Number(prereleaseRaw.match(/\.(\d+)$/)?.[1])
    : null

  if (
    prereleaseRaw &&
    (!Number.isInteger(prereleaseNumber) ||
      prereleaseNumber < 1 ||
      prereleaseNumber > 9998)
  ) {
    throw new Error(`Invalid prerelease number in ${releaseVersion}`)
  }

  return {
    marketingVersion: `${major}.${minor}.${patch}`,
    buildNumber: String(
      major * 100_000_000 +
        minor * 1_000_000 +
        patch * 10_000 +
        (prereleaseNumber ?? 9999)
    )
  }
}

const addHours = (date, hours) =>
  new Date(date.getTime() + hours * 60 * 60 * 1000).toISOString()

const manualRelease = manualVersion
  ? {
      releaseVersion: manualVersion,
      verifiedAt: new Date(),
      runId: 'manual'
    }
  : null
let release = manualRelease

if (!release) {
  try {
    release = await findAutomaticRelease()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const shouldWait = [
      'The latest staging workflow has not completed successfully',
      'The latest staging workflow did not deploy both platforms',
      'No Semantic Release tag was created during the staging run'
    ].includes(message)

    if (!shouldWait) throw error

    writeOutput('changed', 'false')
    writeOutput('release-version', 'waiting-for-successful-deploy')
    writeOutput('run-id', 'none')
    console.log(`Automatic synchronization skipped: ${message}`)
    process.exit(0)
  }
}

const { marketingVersion, buildNumber } = parseReleaseVersion(
  release.releaseVersion
)
const common = {
  enabled: activate || !manualRelease,
  environment: 'staging',
  mode: 'mandatory',
  minimumVersion: marketingVersion,
  minimumBuildNumber: buildNumber,
  releaseAvailable: activate || !manualRelease,
  verifiedAt: release.verifiedAt.toISOString(),
  expiresAt: addHours(release.verifiedAt, 24 * 30),
  mandatoryAfter: addHours(release.verifiedAt, 24),
  reminderAfterHours: 24
}
const policy = {
  policies: [
    {
      id: `ios-staging-${release.releaseVersion}`,
      platform: 'ios',
      channel: 'testflight',
      storeUrl: 'itms-beta://',
      ...common
    },
    {
      id: `android-staging-${release.releaseVersion}`,
      platform: 'android',
      channel: 'play_internal',
      storeUrl:
        'https://play.google.com/store/apps/details?id=com.remis.remismobile.staging',
      ...common
    }
  ]
}

let currentPolicyId = null

try {
  const response = await fetch(`${policyUrl}?requestedAt=${Date.now()}`)
  const current = response.ok ? await response.json() : null
  currentPolicyId = current?.policies?.[0]?.id ?? null
} catch {
  // A missing initial site should trigger the first deployment.
}

const nextPolicyId = policy.policies[0].id
const changed = manualRelease !== null || currentPolicyId !== nextPolicyId

fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, `${JSON.stringify(policy, null, 2)}\n`)
fs.writeFileSync(path.join(path.dirname(outputPath), '.nojekyll'), '')

writeOutput('changed', String(changed))
writeOutput('release-version', release.releaseVersion)
writeOutput('run-id', release.runId)

console.log(
  `${changed ? 'Prepared' : 'Already published'} ${nextPolicyId} (${buildNumber})`
)
