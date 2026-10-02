import { produce } from "immer";
import { z } from "zod";

export const Point = z.object({ x: z.number(), y: z.number() });
export const Overlay = z.discriminatedUnion("kind", [
  z.object({ id:z.string(), page:z.number().int().nonnegative(), kind:z.literal("text"), x:z.number(), y:z.number(), text:z.string(), size:z.number().positive(), color:z.string() }),
  z.object({ id:z.string(), page:z.number().int().nonnegative(), kind:z.literal("ink"), points:z.array(Point).min(2), color:z.string(), width:z.number().positive() }),
  z.object({ id:z.string(), page:z.number().int().nonnegative(), kind:z.enum(["rect","redact"]), x:z.number(), y:z.number(), width:z.number().nonnegative(), height:z.number().nonnegative(), color:z.string() })
]);
export type Overlay = z.infer<typeof Overlay>;
export type Tool = "select"|"text"|"ink"|"rect"|"redact";
export type Command = { type:"add"; overlay:Overlay } | { type:"remove"; id:string } | { type:"rotate"; page:number; before:number; after:number };
export type EditorDocument = { overlays:Overlay[]; rotations:Record<number,number> };
export const emptyDocument=():EditorDocument=>({overlays:[],rotations:{}});
export function applyCommand(state:EditorDocument, command:Command):EditorDocument {
  return produce(state,draft=>{
    if(command.type==="add") draft.overlays.push(command.overlay);
    if(command.type==="remove") draft.overlays=draft.overlays.filter(item=>item.id!==command.id);
    if(command.type==="rotate") draft.rotations[command.page]=((command.after%360)+360)%360;
  });
}
export function inverseCommand(command:Command):Command {
  if(command.type==="add") return {type:"remove",id:command.overlay.id};
  if(command.type==="rotate") return {...command,before:command.after,after:command.before};
  throw new Error("Remove inversion needs the removed overlay snapshot");
}
export function normalizeRect(a:z.infer<typeof Point>,b:z.infer<typeof Point>){return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)}}
