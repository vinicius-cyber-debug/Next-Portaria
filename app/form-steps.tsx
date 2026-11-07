"use client";
import {useEffect, useRef, useState, type RefObject} from 'react';
import {Check, ChevronRight} from 'lucide-react';

type Control=HTMLElement & Pick<HTMLInputElement,'willValidate'|'checkValidity'|'reportValidity'>;
/** Native constraints are checked before moving forward and across every step before saving. */
export function useFormSteps(form:RefObject<HTMLFormElement|null>,count:number,enabled:boolean){
  const [requested,setRequested]=useState(0),frame=useRef<number|null>(null);
  const current=Math.max(0,Math.min(requested,count-1));
  useEffect(()=>()=>{if(frame.current!==null)cancelAnimationFrame(frame.current)},[]);
  function invalidIn(index:number){return Array.from(form.current?.querySelectorAll<Control>(`[data-form-step="${index}"] input,[data-form-step="${index}"] select,[data-form-step="${index}"] textarea`)||[]).find(control=>control.willValidate&&!control.checkValidity())}
  function reveal(index:number,control?:Control){
    setRequested(index);
    if(frame.current!==null)cancelAnimationFrame(frame.current);
    frame.current=requestAnimationFrame(()=>{const target=control||form.current?.querySelector<HTMLElement>(`[data-form-step="${index}"] .form-step-heading`);target?.focus();control?.reportValidity();target?.closest('.modal-body')?.scrollTo({top:0});frame.current=null});
  }
  function go(index:number){
    if(index<0||index>=count)return;
    if(index>current){for(let step=current;step<index;step++){const invalid=invalidIn(step);if(invalid){reveal(step,invalid);return}}}
    reveal(index);
  }
  function beforeSubmit(){
    if(!enabled)return true;
    if(current<count-1){go(current+1);return false}
    for(let step=0;step<count;step++){const invalid=invalidIn(step);if(invalid){reveal(step,invalid);return false}}
    return true;
  }
  return {enabled,current,last:!enabled||current===count-1,go,beforeSubmit};
}
export function FormStepNavigation({titles,current,onSelect,disabled}:{titles:string[];current:number;onSelect:(index:number)=>void;disabled:boolean}){
  return <nav className="form-step-navigation" aria-label="Etapas do cadastro">{titles.map((title,index)=><button type="button" key={title} aria-current={index===current?'step':undefined} className={index===current?'current':index<current?'complete':''} onClick={()=>onSelect(index)} disabled={disabled}><span className="form-step-number">{index<current?<Check size={14}/>:index+1}</span><span>{title}</span>{index<titles.length-1&&<ChevronRight size={14} className="step-divider"/>}</button>)}</nav>;
}
