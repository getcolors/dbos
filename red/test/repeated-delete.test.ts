import {test,expect,spyOn} from "bun:test";
import {run} from "red/workflow";
import * as library from "colors-compute-red";
import * as machine from "../src/machine.ts";
import * as workflow from "../src/workflow.ts";
import * as validate from "../src/validate.ts";
import {mkdtempSync,readdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

test("repeated delete needs no key files and stops before cleanup",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"dbos-repeat-"));
 const reader=spyOn(library,"read_deployment").mockResolvedValue({status:"destroyed"} as any);
 const states=spyOn(validate,"stateErrors").mockReturnValue([]);
 const secrets=spyOn(validate,"secretErrors").mockReturnValue([]);
 try{
  const original=workflow.dbosWorkflow;
  const wf={...original,wireFn:(step:string,opts:any)=>{expect(step).toBe("dbos/start");return original.wireFn(step,opts);}};
  const result=await run(wf,{"red/event":"delete",profile:"absent-keys",workdir:dir,"compute-prevent-destroy":false});
  expect(result["red/exit"]).toBe(0);expect(result["colors-compute/already-destroyed"]).toBe(true);
  expect(reader).toHaveBeenCalledTimes(1);expect(secrets).toHaveBeenCalled();expect(readdirSync(dir)).toEqual([]);
  expect((await machine.load({"red/event":"create"},{}))["red/exit"]).toBe(1);
 }finally{reader.mockRestore();states.mockRestore();secrets.mockRestore();rmSync(dir,{recursive:true,force:true});}
});
test("credential failures and normal failure routing remain",async()=>{
 const reader=spyOn(library,"read_deployment").mockRejectedValue(new Error("must not inspect"));
 const states=spyOn(validate,"stateErrors").mockReturnValue([]);
 const secrets=spyOn(validate,"secretErrors").mockReturnValue(["required credential absent"]);
 try{
  expect((await workflow.startStep({"red/event":"delete","compute-prevent-destroy":false},{}))["red/exit"]).not.toBe(0);
  expect(reader).not.toHaveBeenCalled();
  expect([...workflow.nextFn("x",["y"],{"red/exit":1})!]).toEqual([]);
  const opts={"red/exit":0};expect([...workflow.nextFn("x",["y"],opts)!]).toEqual([["y",opts]]);
 }finally{reader.mockRestore();states.mockRestore();secrets.mockRestore();}
});
