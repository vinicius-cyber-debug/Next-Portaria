"use client";
import {useCallback,useEffect,useRef,useState} from 'react';
import {Camera,RefreshCw,Upload,VideoOff} from 'lucide-react';
import {Button} from './ui';

export function VisitorCamera({photo,onPhoto,enroll=false,disabled=false}:{photo:File|null;onPhoto:(file:File|null)=>void;enroll?:boolean;disabled?:boolean}){
 const video=useRef<HTMLVideoElement>(null),stream=useRef<MediaStream|null>(null),generation=useRef(0);
 const [running,setRunning]=useState(false),[error,setError]=useState(''),[opening,setOpening]=useState(false);
 const stop=()=>{generation.current++;stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;if(video.current)video.current.srcObject=null;setRunning(false);setOpening(false);};
 const previewRef=useCallback((node:HTMLImageElement|null)=>{if(!node||!photo)return;const url=URL.createObjectURL(photo);node.src=url;return ()=>URL.revokeObjectURL(url);},[photo]);
 useEffect(()=>()=>{generation.current=-1;stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;},[]);
 async function start(){
  setError('');if(!navigator.mediaDevices?.getUserMedia){setError('A câmera exige HTTPS ou acesso neste computador. Use a opção de enviar uma foto.');return;}
  const current=++generation.current;setOpening(true);
  try{const camera=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:1280},height:{ideal:720}},audio:false});if(current!==generation.current){camera.getTracks().forEach(track=>track.stop());return;}onPhoto(null);stream.current=camera;if(video.current){video.current.srcObject=camera;await video.current.play();}setRunning(true);}catch{if(current===generation.current)setError('Não foi possível abrir a câmera. Confira a permissão do navegador e a conexão da webcam.');}finally{if(current===generation.current)setOpening(false);}
 }
 async function convert(source:CanvasImageSource,width:number,height:number){
  if(width<160||height<160)throw Error('A foto precisa ter pelo menos 160 × 160 pixels.');
  const ratio=Math.min(1,1280/width,1080/height),canvas=document.createElement('canvas');canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
  const context=canvas.getContext('2d');if(!context)throw Error('Captura não disponível.');context.drawImage(source,0,0,canvas.width,canvas.height);
  const blob=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/jpeg',0.85));if(!blob||blob.size>=2000000)throw Error('A foto deve ter menos de 2 MB.');
  onPhoto(new File([blob],'visitante.jpg',{type:'image/jpeg'}));setError('');stop();
 }
 async function capture(){try{const camera=video.current;if(!camera||!running||!camera.videoWidth)throw Error('Aguarde a imagem da câmera.');await convert(camera,camera.videoWidth,camera.videoHeight);}catch(e){setError(e instanceof Error?e.message:'Não foi possível capturar.');}}
 async function upload(file?:File){
  if(!file)return;setError('');if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>15*1024*1024){setError('Selecione uma imagem JPEG, PNG ou WebP de até 15 MB.');return;}
  stop();onPhoto(null);try{const image=await createImageBitmap(file);try{await convert(image,image.width,image.height);}finally{image.close();}}catch(e){setError(e instanceof Error?e.message:'Imagem inválida.');}
 }
 return <div className="visitor-camera"><div><strong>Foto do visitante</strong><p className="field-hint">Rosto de frente, inteiro e bem iluminado, sem outras pessoas no enquadramento. O equipamento ainda precisa validar a qualidade facial.</p></div>
  <video ref={video} className="visitor-camera-video" autoPlay muted playsInline hidden={!running&&!opening} aria-label="Prévia da câmera do visitante"/>
  {/* Private object URLs stay in this form and are revoked when replaced or closed. */}
  {/* eslint-disable-next-line @next/next/no-img-element */}
  {photo&&!running&&<img className="visitor-camera-preview" ref={previewRef} alt="Foto capturada do visitante para conferência"/>}
  <div className="actions">{!running?<Button disabled={disabled||opening} onClick={()=>void start()}><Camera size={17}/>{opening?'Abrindo câmera…':photo?'Tirar outra foto':'Abrir câmera'}</Button>:<><Button variant="primary" disabled={disabled} onClick={()=>void capture()}><Camera size={17}/>Capturar foto</Button><Button onClick={stop}><VideoOff size={17}/>Fechar câmera</Button></>}
   <label className="button secondary visitor-photo-upload"><Upload size={17}/>Enviar foto<input type="file" accept="image/jpeg,image/png,image/webp" capture="user" disabled={disabled} onChange={e=>{void upload(e.target.files?.[0]);e.target.value='';}}/></label>
   {photo&&<Button disabled={disabled} onClick={()=>{onPhoto(null);setError('');}}><RefreshCw size={16}/>Remover foto</Button>}
  </div>{photo&&<p className="field-hint">{enroll?'Foto capturada para esta visita. Cadastro facial: aguardando envio e confirmação da catraca da portaria.':'Foto capturada para conferência desta visita.'}</p>}{error&&<div className="notice error" role="alert">{error}</div>}
 </div>;
}
