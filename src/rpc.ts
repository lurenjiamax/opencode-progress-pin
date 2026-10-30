import { Rpc } from "@opencode/plugin/rpc"

const object = { type: "object" as const, additionalProperties: true }
export const ProgressPin = Rpc.define({
  id: "progress-pin",
  methods: {
    list: { input: object, output: object },
    status: { input: object, output: object },
    start: { input: object, output: object },
    report: { input: object, output: object },
    cancel: { input: object, output: object },
  },
  events: { changed: { schema: object } },
})
