module.exports = {
  commands: {
    "smoke.list": {
      run() {
        return {
          type: "list",
          searchPlaceholder: "Type to update",
          items: [
            {
              id: "copy",
              title: "Copy hello",
              subtitle: "Tests built-in copy action",
              accessory: "copy",
              actions: [{ type: "copy", label: "Copy", value: "hello from plugin" }],
            },
            {
              id: "detail",
              title: "Open detail",
              subtitle: "Tests custom action",
              actions: [{ type: "custom", label: "Open", id: "detail" }],
            },
          ],
        }
      },
      onSearchChange(text) {
        return {
          type: "list",
          emptyText: "No input yet",
          items: text
            ? [
                {
                  id: "query",
                  title: text,
                  subtitle: "Echo",
                  actions: [{ type: "copy", value: text }],
                },
              ]
            : [],
        }
      },
      onAction(actionId) {
        if (actionId === "detail") {
          return {
            type: "detail",
            markdown: "# Detail View\n\nThis is rendered by the host.",
            metadata: [{ label: "Source", value: "smoke plugin" }],
            actions: [{ type: "copy", label: "Copy detail", value: "detail copied" }],
          }
        }
      },
    },
  },
}
