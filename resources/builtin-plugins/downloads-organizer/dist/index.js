function safeBaseName(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop()
}

function categoryFolder(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
  if (normalized === "documents" || normalized === "document") return "Documents"
  if (normalized === "images" || normalized === "image") return "Images"
  if (normalized === "archives" || normalized === "archive") return "Archives"
  if (normalized === "audio") return "Audio"
  if (normalized === "video" || normalized === "videos") return "Videos"
  return "Other"
}

module.exports = {
  commands: {
    "downloads-organizer.run": {
      run() {
        return { type: "toast", level: "info", message: "Downloads Organizer is active" }
      },
    },
  },
  tools: {
    async classifyAndMove(input, ctx) {
      const fileName = safeBaseName(input.sourceRel)
      if (!fileName) throw new Error("sourceRel must include a file name")
      const folder = categoryFolder(input.category)
      const targetRel = `${folder}/${fileName}`
      const moved = await ctx.fs.move(
        input.sourceRootId,
        input.sourceRel,
        input.sourceRootId,
        targetRel
      )
      await ctx.notifications.show({
        title: "Download organized",
        body: `${fileName} moved to ${folder}.`,
        actions: [{ title: "Undo", journalId: moved.journalId }],
      })
      return {
        content: [
          {
            type: "json",
            json: { targetRel, journalId: moved.journalId, reason: input.reason },
          },
        ],
        structured: { targetRel, journalId: moved.journalId },
      }
    },
  },
  triggers: {
    onDownloads() {
      return undefined
    },
  },
}
