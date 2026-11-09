"use client";
import {useEffect,useState} from 'react';
import {request} from '../lib/http-client';
import {FormField} from './ui';
export type Lookup={id:string;name:string;plate:string;driver:string;company:string};
export async function portoApi<T=Record<string,unknown>>(path:string,body?:unknown):Promise<T>{
 const response=await request('/api/porto/'+path,{method:body?'POST':'GET',cache:'no-store',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
 const data=await response.json() as T&{error?:{message?:string}};if(!response.ok)throw new Error(data.error?.message||'Não foi possível consultar a Gestão do Porto.');return data;
}
export function RecordLookup({kind,label,value,onChange,required=false,emptyLabel}:{kind:'fleet'|'people'|'companies';label:string;value:string;onChange:(record:Lookup)=>void;required?:boolean;emptyLabel?:string}){
 const [query,setQuery]=useState(''),[rows,setRows]=useState<Lookup[]>([]),[selected,setSelected]=useState<Lookup|null>(null),[error,setError]=useState('');
 useEffect(()=>{let active=true;const timer=setTimeout(()=>{portoApi<{rows:Lookup[]}>('cadastros?'+new URLSearchParams({collection:kind,q:query,pageSize:'50'})).then(data=>{if(active){setRows(data.rows);setError('')}}).catch(error=>{if(active)setError(error.message)})},180);return()=>{active=false;clearTimeout(timer)}},[kind,query]);
 const options=selected&&!rows.some(row=>row.id===selected.id)?[selected,...rows]:rows;
 return <div className="porto-lookup"><FormField label={label}><select className="select" value={value} required={required} onChange={event=>{const record=options.find(row=>row.id===event.target.value)||{id:'',name:'',plate:'',driver:'',company:''};setSelected(record);onChange(record)}}><option value="">{emptyLabel||(required?'Selecione um cadastro':'Sem vínculo no cadastro')}</option>{options.map(row=><option key={row.id} value={row.id}>{kind==='fleet'?row.plate:row.name}{row.company?' · '+row.company:''}</option>)}</select></FormField><input className="input porto-lookup-search" type="search" aria-label={'Buscar em '+label.toLowerCase()} placeholder="Filtrar cadastros por nome ou placa…" value={query} onChange={event=>setQuery(event.target.value)}/>{error&&<p className="notice error" role="alert">{error}</p>}<small className="field-hint">Até 50 opções por busca. Cadastros desativados não aparecem.</small></div>;
}
