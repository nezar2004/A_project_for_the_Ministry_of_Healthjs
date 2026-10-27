export class ChatProviderError extends Error {
  constructor(status,code){super(code);this.name='ChatProviderError';this.status=status;this.code=code;}
}
const transient=new Set([408,500,502,503,504]);
export async function generateChatReply({apiKey,model,question,instructions,fetchImpl=globalThis.fetch,timeoutMs=25000,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  for(let attempt=0;attempt<2;attempt++){
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
    let failure;
    try{
      const response=await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent',{
        method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':apiKey},signal:controller.signal,
        body:JSON.stringify({systemInstruction:{parts:[{text:instructions}]},contents:[{role:'user',parts:[{text:question}]}],generationConfig:{temperature:0.25,maxOutputTokens:450}})
      });
      const data=await response.json().catch(error=>{if(response.ok)throw error;return {}});
      if(!response.ok){
        failure=new ChatProviderError(transient.has(response.status)?503:502,response.status===429?'PROVIDER_QUOTA':transient.has(response.status)?'PROVIDER_UNAVAILABLE':'PROVIDER_REJECTED');
        if(!transient.has(response.status))throw failure;
      }else{
        const answer=data?.candidates?.[0]?.content?.parts?.filter(p=>!p.thought).map(p=>p.text||'').join('\n').trim();
        if(answer)return answer;
        if(data?.promptFeedback?.blockReason||data?.candidates?.some(c=>c.finishReason==='SAFETY'))throw new ChatProviderError(422,'PROVIDER_SAFETY');
        throw new ChatProviderError(502,'PROVIDER_EMPTY');
      }
    }catch(error){
      if(error instanceof ChatProviderError)throw error;
      const timedOut=controller.signal.aborted||['AbortError','TimeoutError'].includes(error?.name);
      if(!timedOut && !(error instanceof TypeError))throw new ChatProviderError(502,'PROVIDER_INVALID_RESPONSE');
      failure=new ChatProviderError(timedOut?504:503,timedOut?'PROVIDER_TIMEOUT':'PROVIDER_CONNECTION');
    }finally{clearTimeout(timer)}
    if(attempt===1)throw failure;
    await pause(350);
  }
}
