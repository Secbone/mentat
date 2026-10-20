"""Local diagnostic relay: fixed official upstream, no credential/body logging or rewriting."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import httpx

parser=argparse.ArgumentParser()
parser.add_argument('--log',type=Path,required=True)
parser.add_argument('--port',type=int,default=19041)
args=parser.parse_args()
args.log.parent.mkdir(parents=True,exist_ok=True)

def record(value):
    with args.log.open('a') as stream: stream.write(json.dumps(value)+'\n')

class Handler(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def log_message(self,*args): pass
    def do_POST(self):
        if self.path!='/chat/completions':
            self.send_error(404);return
        raw=self.rfile.read(int(self.headers.get('content-length','0')))
        body=json.loads(raw)
        tools=body.get('tools',[])
        record({'type':'request','model':body.get('model'),'toolNames':[t.get('function',{}).get('name') for t in tools],
                'toolChoice':body.get('tool_choice'),'messageRoles':[m['role'] for m in body.get('messages',[])],
                'mentatSystem':any(m.get('role')=='system' and 'Mentat personal assistant policy' in str(m.get('content','')) for m in body.get('messages',[]))})
        headers={k:v for k,v in self.headers.items() if k.lower() not in {'host','content-length','connection','accept-encoding'}}
        content=[];calls=[];finish=[]
        try:
            with httpx.Client(timeout=240,trust_env=False) as client:
                with client.stream('POST','https://opencode.ai/zen/go/v1/chat/completions',content=raw,headers=headers) as response:
                    self.send_response(response.status_code)
                    self.send_header('content-type',response.headers.get('content-type','text/event-stream'))
                    self.send_header('connection','close');self.end_headers()
                    for line in response.iter_lines():
                        self.wfile.write((line+'\n').encode());self.wfile.flush()
                        if not line.startswith('data: '):continue
                        try: event=json.loads(line[6:])
                        except ValueError:continue
                        for choice in event.get('choices',[]):
                            delta=choice.get('delta',{})
                            if delta.get('content'):content.append(delta['content'])
                            for call in delta.get('tool_calls',[]):
                                name=call.get('function',{}).get('name')
                                if name:calls.append(name)
                            if choice.get('finish_reason'):finish.append(choice['finish_reason'])
                    record({'type':'response','httpStatus':response.status_code,'nativeToolCalls':calls,'finishReasons':finish,'hasDSML':'DSML' in ''.join(content),'textCharacters':sum(map(len,content))})
        except Exception as error:
            record({'type':'relay-error','errorType':type(error).__name__})
        self.close_connection=True

print(f'relay listening 127.0.0.1:{args.port}',flush=True)
ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
