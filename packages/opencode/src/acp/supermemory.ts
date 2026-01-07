import { Log } from "../util/log"
import * as path from "node:path"
import * as crypto from "node:crypto"

const log = Log.create({ service: "acp-supermemory" })

interface MemoryResult {
  id: string
  memory?: string
  chunk?: string
  similarity: number
  title?: string
  metadata?: Record<string, unknown>
}

interface SearchResponse {
  success: boolean
  results?: MemoryResult[]
  error?: string
}

interface ProfileResponse {
  success: boolean
  profile?: {
    static?: string[]
    dynamic?: string[]
  }
  error?: string
}

interface ListResponse {
  success: boolean
  memories?: Array<{
    id: string
    summary: string
    title?: string
    createdAt?: string
    metadata?: Record<string, unknown>
  }>
  error?: string
}

const MAX_PROJECT_MEMORIES = 20

function getApiKey(): string | undefined {
  return process.env.SUPERMEMORY_API_KEY
}

function getTags(directory: string): { user: string; project: string } {
  const username = process.env.USER || process.env.USERNAME || "default"
  const userHash = crypto.createHash("sha256").update(username).digest("hex").slice(0, 8)

  const projectName = path.basename(directory)
  const projectHash = crypto.createHash("sha256").update(directory).digest("hex").slice(0, 8)

  return {
    user: `opencode-user-${userHash}`,
    project: `opencode-project-${projectName}-${projectHash}`,
  }
}

async function searchMemories(query: string, containerTag: string): Promise<SearchResponse> {
  const apiKey = getApiKey()
  if (!apiKey) {
    return { success: false, error: "SUPERMEMORY_API_KEY not set" }
  }

  try {
    const response = await fetch("https://api.supermemory.ai/v3/memories/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        containerTags: [containerTag],
        limit: 10,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      log.error("supermemory search failed", { status: response.status, error: errorText })
      return { success: false, error: `API error: ${response.status}` }
    }

    const data = await response.json()
    return {
      success: true,
      results: data.results || [],
    }
  } catch (error) {
    log.error("supermemory search error", { error })
    return { success: false, error: String(error) }
  }
}

async function getProfile(containerTag: string, context?: string): Promise<ProfileResponse> {
  const apiKey = getApiKey()
  if (!apiKey) {
    return { success: false, error: "SUPERMEMORY_API_KEY not set" }
  }

  try {
    const params = new URLSearchParams({ containerTag })
    if (context) {
      params.append("context", context)
    }

    const response = await fetch(`https://api.supermemory.ai/v3/profile?${params}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      log.error("supermemory profile failed", { status: response.status, error: errorText })
      return { success: false, error: `API error: ${response.status}` }
    }

    const data = await response.json()
    return {
      success: true,
      profile: data.profile,
    }
  } catch (error) {
    log.error("supermemory profile error", { error })
    return { success: false, error: String(error) }
  }
}

async function listMemories(containerTag: string, limit: number = 20): Promise<ListResponse> {
  const apiKey = getApiKey()
  if (!apiKey) {
    return { success: false, error: "SUPERMEMORY_API_KEY not set" }
  }

  try {
    const params = new URLSearchParams({
      containerTags: containerTag,
      limit: String(limit),
    })

    const response = await fetch(`https://api.supermemory.ai/v3/memories?${params}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      log.error("supermemory list failed", { status: response.status, error: errorText })
      return { success: false, error: `API error: ${response.status}` }
    }

    const data = await response.json()
    return {
      success: true,
      memories: data.memories || [],
    }
  } catch (error) {
    log.error("supermemory list error", { error })
    return { success: false, error: String(error) }
  }
}

function formatContextForPrompt(
  profile: ProfileResponse | null,
  userMemories: SearchResponse,
  projectMemories: { results: MemoryResult[] },
): string | null {
  const sections: string[] = []

  // User profile
  if (profile?.profile) {
    const staticFacts = profile.profile.static || []
    const dynamicFacts = profile.profile.dynamic || []

    if (staticFacts.length > 0 || dynamicFacts.length > 0) {
      const profileLines = ["## User Profile"]
      if (staticFacts.length > 0) {
        profileLines.push(...staticFacts.map((f) => `- ${f}`))
      }
      if (dynamicFacts.length > 0) {
        profileLines.push(...dynamicFacts.map((f) => `- ${f}`))
      }
      sections.push(profileLines.join("\n"))
    }
  }

  // Project memories
  if (projectMemories.results && projectMemories.results.length > 0) {
    const projectLines = ["## Project Context"]
    for (const mem of projectMemories.results.slice(0, 10)) {
      const content = mem.memory || mem.chunk || ""
      if (content) {
        // Truncate long memories
        const truncated = content.length > 500 ? content.slice(0, 500) + "..." : content
        projectLines.push(`- ${truncated}`)
      }
    }
    if (projectLines.length > 1) {
      sections.push(projectLines.join("\n"))
    }
  }

  // Relevant user memories (from search)
  if (userMemories.results && userMemories.results.length > 0) {
    const relevantMemories = userMemories.results.filter((m) => m.similarity > 0.5)
    if (relevantMemories.length > 0) {
      const userLines = ["## Relevant User Knowledge"]
      for (const mem of relevantMemories.slice(0, 5)) {
        const content = mem.memory || mem.chunk || ""
        if (content) {
          const truncated = content.length > 300 ? content.slice(0, 300) + "..." : content
          userLines.push(`- ${truncated}`)
        }
      }
      if (userLines.length > 1) {
        sections.push(userLines.join("\n"))
      }
    }
  }

  if (sections.length === 0) {
    return null
  }

  return `<system-reminder>
# Supermemory Context

The following context was automatically retrieved from the user's persistent memory.
Use this information to provide more personalized and contextually relevant assistance.

${sections.join("\n\n")}
</system-reminder>`
}

export async function getSupermemoryContext(directory: string, userMessage: string): Promise<string | null> {
  const apiKey = getApiKey()
  if (!apiKey) {
    log.debug("supermemory disabled - no API key")
    return null
  }

  const tags = getTags(directory)
  log.info("fetching supermemory context", { tags, messagePreview: userMessage.slice(0, 50) })

  try {
    const [profileResult, userMemoriesResult, projectMemoriesListResult] = await Promise.all([
      getProfile(tags.user, userMessage),
      searchMemories(userMessage, tags.user),
      listMemories(tags.project, MAX_PROJECT_MEMORIES),
    ])

    const profile = profileResult.success ? profileResult : null
    const userMemories = userMemoriesResult.success ? userMemoriesResult : { success: true, results: [] }
    const projectMemoriesList = projectMemoriesListResult.success
      ? projectMemoriesListResult
      : { success: true, memories: [] }

    // Convert list to search-like results format
    const projectMemories = {
      results: (projectMemoriesList.memories || []).map((m) => ({
        id: m.id,
        memory: m.summary,
        similarity: 1,
        title: m.title,
        metadata: m.metadata,
      })),
    }

    const context = formatContextForPrompt(profile, userMemories, projectMemories)

    if (context) {
      log.info("supermemory context generated", { length: context.length })
    } else {
      log.debug("no supermemory context available")
    }

    return context
  } catch (error) {
    log.error("failed to get supermemory context", { error })
    return null
  }
}

export function isSupermemoryConfigured(): boolean {
  return !!getApiKey()
}
