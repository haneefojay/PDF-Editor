import { describe,expect,it } from "vitest";
import { applyCommand,emptyDocument,inverseCommand,normalizeRect } from "./index";
describe("commands",()=>{
 it("applies and reverses an add",()=>{const c={type:"add",overlay:{id:"1",page:0,kind:"text",x:1,y:2,text:"Hello",size:16,color:"#111"}} as const;const next=applyCommand(emptyDocument(),c);expect(next.overlays).toHaveLength(1);expect(applyCommand(next,inverseCommand(c)).overlays).toHaveLength(0)});
 it("normalizes reverse drags",()=>expect(normalizeRect({x:10,y:20},{x:2,y:4})).toEqual({x:2,y:4,width:8,height:16}));
 it("normalizes rotation",()=>expect(applyCommand(emptyDocument(),{type:"rotate",page:0,before:0,after:450}).rotations[0]).toBe(90));
});
