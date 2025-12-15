## Classes

<dl>
<dt><a href="#JambonzSession">JambonzSession</a></dt>
<dd></dd>
<dt><a href="#Agent">Agent</a></dt>
<dd></dd>
<dt><a href="#Application">Application</a></dt>
<dd></dd>
<dt><a href="#GoogleHelper">GoogleHelper</a></dt>
<dd></dd>
<dt><a href="#Jambonz">Jambonz</a></dt>
<dd></dd>
<dt><a href="#Llm">Llm</a></dt>
<dd></dd>
<dt><a href="#Anthropic">Anthropic</a> ⇐ <code><a href="#Llm">Llm</a></code></dt>
<dd></dd>
<dt><a href="#Gemini">Gemini</a> ⇐ <code><a href="#Google">Google</a></code></dt>
<dd></dd>
<dt><a href="#Google">Google</a> ⇐ <code><a href="#Llm">Llm</a></code></dt>
<dd></dd>
<dt><a href="#Google">Google</a> ⇐ <code><a href="#Llm">Llm</a></code></dt>
<dd></dd>
<dt><a href="#OpenAi">OpenAi</a> ⇐ <code><a href="#Llm">Llm</a></code></dt>
<dd></dd>
<dt><a href="#Palm2">Palm2</a> ⇐ <code><a href="#Llm">Llm</a></code></dt>
<dd></dd>
</dl>

## Typedefs

<dl>
<dt><a href="#Completion">Completion</a> : <code>Object</code></dt>
<dd></dd>
<dt><a href="#CallHook">CallHook</a> : <code>Object</code></dt>
<dd>Configuration for external callbacks on call start/end.</dd>
</dl>

<a name="JambonzSession"></a>

## JambonzSession
**Kind**: global class  

* [JambonzSession](#JambonzSession)
    * [new JambonzSession({, params)](#new_JambonzSession_new)
    * [.handler()](#JambonzSession+handler) ⇒ <code>Promise</code>
    * [.forceClose()](#JambonzSession+forceClose) ⇒ <code>Promise</code>
    * [.inject(text)](#JambonzSession+inject) ⇒ <code>Promise</code>

<a name="new_JambonzSession_new"></a>

### new JambonzSession({, params)

| Param | Type | Description |
| --- | --- | --- |
| { | <code>\*</code> | progress, logger, session, llmClass, prompt, options } |
| params | <code>Object</code> | Session parameters |
| params.path | <code>string</code> | The path to this service |
| params.agent | [<code>Llm</code>](#Llm) | LLM class instance for implementation class |
| params.progress | <code>WebSocket</code> | A websocket to write progress messages to |
| params.logger | <code>Object</code> | Pino logger instance |
| params.session | <code>Object</code> | Jambonz WebSocket session object |
| params.options | <code>Object</code> | Options object containing combined STT, TTS and model options |

<a name="JambonzSession+handler"></a>

### jambonzSession.handler() ⇒ <code>Promise</code>
Handler for a Jambonz session, main wait loop that sets listeners on Jambonz and the LLM agent
dispatches messages between them as long as they are both responding and closes them gracefully
on hangup or other errors.

**Kind**: instance method of [<code>JambonzSession</code>](#JambonzSession)  
**Returns**: <code>Promise</code> - Resolves to a void value when the conversation ends  
<a name="JambonzSession+forceClose"></a>

### jambonzSession.forceClose() ⇒ <code>Promise</code>
Force closes a (maybe) open session, send some polite text to the caller
then hangup. Doesn't really do much of the cleanup, just waits for it to
happen

**Kind**: instance method of [<code>JambonzSession</code>](#JambonzSession)  
**Returns**: <code>Promise</code> - Resolves to a void value when the conversation finally closes  
<a name="JambonzSession+inject"></a>

### jambonzSession.inject(text) ⇒ <code>Promise</code>
Inject a phrase into the conversation via TTS. Doesn't change the AI turn in any way

**Kind**: instance method of [<code>JambonzSession</code>](#JambonzSession)  
**Returns**: <code>Promise</code> - resolves when Jambonz accepts transaction  

| Param | Type | Description |
| --- | --- | --- |
| text | <code>string</code> | text to be spoken into the conversation by TTS |

<a name="Agent"></a>

## Agent
**Kind**: global class  
<a name="new_Agent_new"></a>

### new Agent({, params, logger, [prompt])

| Param | Type | Description |
| --- | --- | --- |
| { | <code>\*</code> | name, llmClass, logger, wsServer, makeService, prompt, options, handleClose = () => (null)} |
| params | <code>Object</code> | Application creation parameters |
| params.name | <code>string</code> | supported LLM agent name, must be one of #Application.agents |
| [params.wsServer] | <code>Object</code> | An HTTP server object to attach an progress websocket to |
| params.makeService | <code>function</code> | A Jambonz WS SDK makeServer Function |
| [params.options] | <code>Object</code> | Options object to pass down to the underlying LLM agent |
| logger | <code>Object</code> | Pino logger instance |
| params.name | <code>string</code> | Globally unique id for this agent instance |
| [prompt] | <code>string</code> | Initial (system) prompt to the agent |

<a name="Application"></a>

## Application
**Kind**: global class  

* [Application](#Application)
    * [new Application(params)](#new_Application_new)
    * _instance_
        * [.create()](#Application+create) ⇒ <code>string</code>
        * [.destroy()](#Application+destroy)
    * _static_
        * [.live](#Application.live)
        * [.agents](#Application.agents)
        * [.recover(id)](#Application.recover) ⇒ [<code>Application</code>](#Application)
        * [.listModels()](#Application.listModels) ⇒ <code>Array.&lt;Object&gt;</code>
        * [.clean()](#Application.clean) ⇒ <code>Promise</code>
        * [.cleanAll()](#Application.cleanAll)

<a name="new_Application_new"></a>

### new Application(params)
Create a new application


| Param | Type | Description |
| --- | --- | --- |
| params | <code>Object</code> | Application creation parameters |
| params.modelName | <code>string</code> | supported LLM agent name, must be one of #Application.agents |
| params.wsServer | <code>Object</code> | An HTTP server object to attach an progress websocket to |
| params.makeService | <code>function</code> | A Jambonz WS SDK makeServer Function |
| params.options | <code>Object</code> | Options object to pass down to the underlying LLM agent |
| params.logger | <code>Object</code> | Pino logger instance |
| params.name | <code>string</code> | Globally unique id for this agent instance, receives a new uuid.v4 if not set |
| params.prompt | <code>string</code> | Initial (system) prompt to the agent |

<a name="Application+create"></a>

### application.create() ⇒ <code>string</code>
Create a new application by instantiating a local Jambonz WS listener on a 
UUID keyed path, then creating a Jambonz application which calls it.
Then finds a phone number not currently linked to an application and links it to this one.

**Kind**: instance method of [<code>Application</code>](#Application)  
**Returns**: <code>string</code> - textual phone number linked to the new application  
<a name="Application+destroy"></a>

### application.destroy()
Delete this Jambonz application

**Kind**: instance method of [<code>Application</code>](#Application)  
<a name="Application.live"></a>

### Application.live
List of all live applications instantiated by this server

**Kind**: static property of [<code>Application</code>](#Application)  
<a name="Application.agents"></a>

### Application.agents
All of the current agent types we can handle keyed by short identifier

**Kind**: static property of [<code>Application</code>](#Application)  
<a name="Application.recover"></a>

### Application.recover(id) ⇒ [<code>Application</code>](#Application)
Find the application corresponding to an ID

**Kind**: static method of [<code>Application</code>](#Application)  

| Param | Type |
| --- | --- |
| id | <code>string</code> | 

<a name="Application.listModels"></a>

### Application.listModels() ⇒ <code>Array.&lt;Object&gt;</code>
List of available agent types

**Kind**: static method of [<code>Application</code>](#Application)  
**Returns**: <code>Array.&lt;Object&gt;</code> - agents  
<a name="Application.clean"></a>

### Application.clean() ⇒ <code>Promise</code>
Destroy all initialised applications created by this application

**Kind**: static method of [<code>Application</code>](#Application)  
**Returns**: <code>Promise</code> - resolves when all applications have been removed from the Jambonz instance  
<a name="Application.cleanAll"></a>

### Application.cleanAll()
Really aggressively scour the Jambonz instance for anything that looks like
an auto created application of ours, unlink the phone number and delete the application

**Kind**: static method of [<code>Application</code>](#Application)  
<a name="GoogleHelper"></a>

## GoogleHelper
**Kind**: global class  
<a name="GoogleHelper+listVoices"></a>

### googleHelper.listVoices() ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code>
Get all of the Google TTS voices

**Kind**: instance method of [<code>GoogleHelper</code>](#GoogleHelper)  
**Returns**: <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code> - All Jambonz number resources on the instance  
<a name="Jambonz"></a>

## Jambonz
**Kind**: global class  

* [Jambonz](#Jambonz)
    * [new Jambonz()](#new_Jambonz_new)
    * _instance_
        * [.listNumbers()](#Jambonz+listNumbers) ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code>
        * [.listCarriers()](#Jambonz+listCarriers) ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code>
        * [.getNumber(sid)](#Jambonz+getNumber) ⇒ <code>Promise.&lt;Object&gt;</code>
        * [.addNumber({)](#Jambonz+addNumber) ⇒ <code>Promise.&lt;string&gt;</code>
        * [.updateNumber(sid, {)](#Jambonz+updateNumber) ⇒ <code>Promise</code>
        * [.deleteNumber(sid)](#Jambonz+deleteNumber) ⇒ <code>Promise</code>
        * [.listApplications()](#Jambonz+listApplications) ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code>
        * [.getApplication(sid)](#Jambonz+getApplication) ⇒ <code>Promise.&lt;Object&gt;</code>
        * [.addApplication({)](#Jambonz+addApplication) ⇒ <code>Promise</code>
        * [.updateApplication(sid, {)](#Jambonz+updateApplication) ⇒ <code>Promise</code>
        * [.deleteApplication(sid)](#Jambonz+deleteApplication) ⇒ <code>Promise</code>
    * _static_
        * [.Jambonz](#Jambonz.Jambonz)
            * [new Jambonz(logger, user)](#new_Jambonz.Jambonz_new)

<a name="new_Jambonz_new"></a>

### new Jambonz()
Client implementation of selected parts of the Jambonz API

<a name="Jambonz+listNumbers"></a>

### jambonz.listNumbers() ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code>
Gett all of the Jambonz numbers on the instance

**Kind**: instance method of [<code>Jambonz</code>](#Jambonz)  
**Returns**: <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code> - All Jambonz number resources on the instance  
<a name="Jambonz+listCarriers"></a>

### jambonz.listCarriers() ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code>
Get all of the Jambonz Service Providers

**Kind**: instance method of [<code>Jambonz</code>](#Jambonz)  
**Returns**: <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code> - All Jambonz number resources on the instance  
<a name="Jambonz+getNumber"></a>

### jambonz.getNumber(sid) ⇒ <code>Promise.&lt;Object&gt;</code>
**Kind**: instance method of [<code>Jambonz</code>](#Jambonz)  
**Returns**: <code>Promise.&lt;Object&gt;</code> - Jambonz number detail  

| Param | Type |
| --- | --- |
| sid | <code>string</code> | 

<a name="Jambonz+addNumber"></a>

### jambonz.addNumber({) ⇒ <code>Promise.&lt;string&gt;</code>
Add a new number

**Kind**: instance method of [<code>Jambonz</code>](#Jambonz)  
**Returns**: <code>Promise.&lt;string&gt;</code> - sid  

| Param | Type | Description |
| --- | --- | --- |
| { | <code>Object</code> | number, carrier, application } |

<a name="Jambonz+updateNumber"></a>

### jambonz.updateNumber(sid, {) ⇒ <code>Promise</code>
Update detail of a number

**Kind**: instance method of [<code>Jambonz</code>](#Jambonz)  
**Returns**: <code>Promise</code> - resolves on completion  

| Param | Type | Description |
| --- | --- | --- |
| sid | <code>string</code> |  |
| { | <code>Object</code> | carrier, application } to update |

<a name="Jambonz+deleteNumber"></a>

### jambonz.deleteNumber(sid) ⇒ <code>Promise</code>
Delete Number

**Kind**: instance method of [<code>Jambonz</code>](#Jambonz)  
**Returns**: <code>Promise</code> - resolves on completion  

| Param | Type |
| --- | --- |
| sid | <code>string</code> | 

<a name="Jambonz+listApplications"></a>

### jambonz.listApplications() ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code>
Get a list of applications

**Kind**: instance method of [<code>Jambonz</code>](#Jambonz)  
**Returns**: <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code> - List of applications  
<a name="Jambonz+getApplication"></a>

### jambonz.getApplication(sid) ⇒ <code>Promise.&lt;Object&gt;</code>
Get an application by sid

**Kind**: instance method of [<code>Jambonz</code>](#Jambonz)  

| Param | Type |
| --- | --- |
| sid | <code>string</code> | 

<a name="Jambonz+addApplication"></a>

### jambonz.addApplication({) ⇒ <code>Promise</code>
Add an application

**Kind**: instance method of [<code>Jambonz</code>](#Jambonz)  
**Returns**: <code>Promise</code> - resolves on creation  

| Param | Type | Description |
| --- | --- | --- |
| { | <code>Object</code> | name,     url,     stt,     tts   } |

<a name="Jambonz+updateApplication"></a>

### jambonz.updateApplication(sid, {) ⇒ <code>Promise</code>
Update an application

**Kind**: instance method of [<code>Jambonz</code>](#Jambonz)  
**Returns**: <code>Promise</code> - resolves on update  

| Param | Type | Description |
| --- | --- | --- |
| sid | <code>string</code> |  |
| { | <code>Object</code> | name,     url,     stt,     tts   } |

<a name="Jambonz+deleteApplication"></a>

### jambonz.deleteApplication(sid) ⇒ <code>Promise</code>
**Kind**: instance method of [<code>Jambonz</code>](#Jambonz)  
**Returns**: <code>Promise</code> - resolves on completion  

| Param | Type |
| --- | --- |
| sid | <code>string</code> | 

<a name="Jambonz.Jambonz"></a>

### Jambonz.Jambonz
**Kind**: static class of [<code>Jambonz</code>](#Jambonz)  
<a name="new_Jambonz.Jambonz_new"></a>

#### new Jambonz(logger, user)
Creates an instance of Jambonz.


| Param | Type | Description |
| --- | --- | --- |
| logger | <code>Object</code> | pino logger instance |
| user | <code>string</code> | User identifier |

<a name="Llm"></a>

## Llm
**Kind**: global class  

* [Llm](#Llm)
    * [new Llm()](#new_Llm_new)
    * _instance_
        * [.voiceHints](#Llm+voiceHints)
        * [.completion(input)](#Llm+completion) ⇒ [<code>Completion</code>](#Completion)
    * _static_
        * [.Llm](#Llm.Llm)
            * [new Llm(logger, user, prompt, options)](#new_Llm.Llm_new)
        * [.supportsFunctions](#Llm.supportsFunctions)

<a name="new_Llm_new"></a>

### new Llm()
Superclass for an Llm interface: generic constructor, completion and hint parsing

<a name="Llm+voiceHints"></a>

### llm.voiceHints
A list of all the unique words in the initial prompt.
Useful as hints for STT context priming.

**Kind**: instance property of [<code>Llm</code>](#Llm)  
**Read only**: true  
<a name="Llm+completion"></a>

### llm.completion(input) ⇒ [<code>Completion</code>](#Completion)
Parse a raw completion, return speech text, data and hangup signal

**Kind**: instance method of [<code>Llm</code>](#Llm)  
**Returns**: [<code>Completion</code>](#Completion) - completion parsed completion  

| Param | Type | Description |
| --- | --- | --- |
| input | <code>string</code> | raw completion |

<a name="Llm.Llm"></a>

### Llm.Llm
**Kind**: static class of [<code>Llm</code>](#Llm)  
<a name="new_Llm.Llm_new"></a>

#### new Llm(logger, user, prompt, options)

| Param | Type | Description |
| --- | --- | --- |
| logger | <code>Object</code> | Pino logger instance |
| user | <code>string</code> | a unique user ID |
| prompt | <code>string</code> | The initial (system) chat prompt |
| options | <code>Object</code> | options |
| options.temperature | <code>number</code> | The LLM temperature                 See model documentation |

<a name="Llm.supportsFunctions"></a>

### Llm.supportsFunctions
Default us not to support function calling

**Kind**: static property of [<code>Llm</code>](#Llm)  
<a name="Anthropic"></a>

## Anthropic ⇐ [<code>Llm</code>](#Llm)
**Kind**: global class  
**Extends**: [<code>Llm</code>](#Llm)  

* [Anthropic](#Anthropic) ⇐ [<code>Llm</code>](#Llm)
    * [new Anthropic(logger, user, prompt, options)](#new_Anthropic_new)
    * _instance_
        * [.voiceHints](#Llm+voiceHints)
        * [.completion(input)](#Llm+completion) ⇒ [<code>Completion</code>](#Completion)
    * _static_
        * [.AnthropicLlm](#Anthropic.AnthropicLlm)
            * [new AnthropicLlm()](#new_Anthropic.AnthropicLlm_new)

<a name="new_Anthropic_new"></a>

### new Anthropic(logger, user, prompt, options)
Implements the LLM class against the Anthropic Claude models


| Param | Type | Description |
| --- | --- | --- |
| logger | <code>Object</code> | Pino logger instance |
| user | <code>string</code> | a unique user ID |
| prompt | <code>string</code> | The initial (system) chat prompt |
| options | <code>Object</code> | options |
| options.temperature | <code>number</code> | The LLM temperature                 See model documentation |

<a name="Llm+voiceHints"></a>

### anthropic.voiceHints
A list of all the unique words in the initial prompt.
Useful as hints for STT context priming.

**Kind**: instance property of [<code>Anthropic</code>](#Anthropic)  
**Read only**: true  
<a name="Llm+completion"></a>

### anthropic.completion(input) ⇒ [<code>Completion</code>](#Completion)
Parse a raw completion, return speech text, data and hangup signal

**Kind**: instance method of [<code>Anthropic</code>](#Anthropic)  
**Returns**: [<code>Completion</code>](#Completion) - completion parsed completion  

| Param | Type | Description |
| --- | --- | --- |
| input | <code>string</code> | raw completion |

<a name="Anthropic.AnthropicLlm"></a>

### Anthropic.AnthropicLlm
**Kind**: static class of [<code>Anthropic</code>](#Anthropic)  
<a name="new_Anthropic.AnthropicLlm_new"></a>

#### new AnthropicLlm()
Creates an instance of Anthropic.

<a name="Gemini"></a>

## Gemini ⇐ [<code>Google</code>](#Google)
**Kind**: global class  
**Extends**: [<code>Google</code>](#Google)  

* [Gemini](#Gemini) ⇐ [<code>Google</code>](#Google)
    * [new Gemini()](#new_Gemini_new)
    * _instance_
        * [.initial()](#Google+initial) ⇒ <code>string</code>
        * [.rawCompletion(input)](#Google+rawCompletion) ⇒ <code>string</code>
    * _static_
        * [.Gemini](#Gemini.Gemini)
            * [new Gemini(logger, user, prompt, options)](#new_Gemini.Gemini_new)

<a name="new_Gemini_new"></a>

### new Gemini()
Implements the LLM class for Google's Gemini model via the Vertex AI
interface.

<a name="Google+initial"></a>

### gemini.initial() ⇒ <code>string</code>
Start the chat session and return the initial greeting

**Kind**: instance method of [<code>Gemini</code>](#Gemini)  
**Overrides**: [<code>initial</code>](#Google+initial)  
**Returns**: <code>string</code> - initial response  
<a name="Google+rawCompletion"></a>

### gemini.rawCompletion(input) ⇒ <code>string</code>
Generate the next round of chat response

**Kind**: instance method of [<code>Gemini</code>](#Gemini)  
**Overrides**: [<code>rawCompletion</code>](#Google+rawCompletion)  
**Returns**: <code>string</code> - the raw completion output from Google model  

| Param | Type | Description |
| --- | --- | --- |
| input | <code>string</code> | the user prompt input text |

<a name="Gemini.Gemini"></a>

### Gemini.Gemini
**Kind**: static class of [<code>Gemini</code>](#Gemini)  
<a name="new_Gemini.Gemini_new"></a>

#### new Gemini(logger, user, prompt, options)
Creates an instance of Gemini.


| Param | Type | Description |
| --- | --- | --- |
| logger | <code>Object</code> | Pino logger instance |
| user | <code>string</code> | a unique user ID |
| prompt | <code>string</code> | The initial (system) chat prompt |
| options | <code>Object</code> | options |
| options.temperature | <code>number</code> | The LLM temperature                 See model documentation |

<a name="Google"></a>

## Google ⇐ [<code>Llm</code>](#Llm)
**Kind**: global class  
**Extends**: [<code>Llm</code>](#Llm)  

* [Google](#Google) ⇐ [<code>Llm</code>](#Llm)
    * [new Google()](#new_Google_new)
    * [new Google()](#new_Google_new)
    * _instance_
        * [.voiceHints](#Llm+voiceHints)
        * [.initial()](#Google+initial) ⇒ <code>string</code>
        * [.rawCompletion(input)](#Google+rawCompletion) ⇒ <code>string</code>
        * [.initial()](#Google+initial) ⇒ <code>string</code>
        * [.rawCompletion(input)](#Google+rawCompletion) ⇒ <code>string</code>
        * [.completion(input)](#Llm+completion) ⇒ [<code>Completion</code>](#Completion)
    * _static_
        * [.Google](#Google.Google)
            * [new Google(logger, user, prompt, options)](#new_Google.Google_new)
            * [new Google(logger, user, prompt, options, location, model)](#new_Google.Google_new)
        * [.Google](#Google.Google)
            * [new Google(logger, user, prompt, options)](#new_Google.Google_new)
            * [new Google(logger, user, prompt, options, location, model)](#new_Google.Google_new)
        * [.supportsFunctions](#Google.supportsFunctions)

<a name="new_Google_new"></a>

### new Google()
Implements the LLM class for Google's Google model via the Vertex AI
interface.

<a name="new_Google_new"></a>

### new Google()
Implements the LLM class for Google's Vertex AI platform
interface.

<a name="Llm+voiceHints"></a>

### google.voiceHints
A list of all the unique words in the initial prompt.
Useful as hints for STT context priming.

**Kind**: instance property of [<code>Google</code>](#Google)  
**Overrides**: [<code>voiceHints</code>](#Llm+voiceHints)  
**Read only**: true  
<a name="Google+initial"></a>

### google.initial() ⇒ <code>string</code>
Start the chat session and return the initial greeting

**Kind**: instance method of [<code>Google</code>](#Google)  
**Returns**: <code>string</code> - initial response  
<a name="Google+rawCompletion"></a>

### google.rawCompletion(input) ⇒ <code>string</code>
Generate the next round of chat response

**Kind**: instance method of [<code>Google</code>](#Google)  
**Returns**: <code>string</code> - the raw completion output from Google model  

| Param | Type | Description |
| --- | --- | --- |
| input | <code>string</code> | the user prompt input text |

<a name="Google+initial"></a>

### google.initial() ⇒ <code>string</code>
Start the chat session and return the initial greeting

**Kind**: instance method of [<code>Google</code>](#Google)  
**Returns**: <code>string</code> - initial response  
<a name="Google+rawCompletion"></a>

### google.rawCompletion(input) ⇒ <code>string</code>
Generate the next round of chat response

**Kind**: instance method of [<code>Google</code>](#Google)  
**Returns**: <code>string</code> - the raw completion output from Google model  

| Param | Type | Description |
| --- | --- | --- |
| input | <code>string</code> | the user prompt input text |

<a name="Llm+completion"></a>

### google.completion(input) ⇒ [<code>Completion</code>](#Completion)
Parse a raw completion, return speech text, data and hangup signal

**Kind**: instance method of [<code>Google</code>](#Google)  
**Overrides**: [<code>completion</code>](#Llm+completion)  
**Returns**: [<code>Completion</code>](#Completion) - completion parsed completion  

| Param | Type | Description |
| --- | --- | --- |
| input | <code>string</code> | raw completion |

<a name="Google.Google"></a>

### Google.Google
**Kind**: static class of [<code>Google</code>](#Google)  

* [.Google](#Google.Google)
    * [new Google(logger, user, prompt, options)](#new_Google.Google_new)
    * [new Google(logger, user, prompt, options, location, model)](#new_Google.Google_new)

<a name="new_Google.Google_new"></a>

#### new Google(logger, user, prompt, options)
Creates an instance of Google LLM.


| Param | Type | Description |
| --- | --- | --- |
| logger | <code>Object</code> | Pino logger instance |
| user | <code>string</code> | a unique user ID |
| prompt | <code>string</code> | The initial (system) chat prompt |
| options | <code>Object</code> | options |
| options.temperature | <code>number</code> | The LLM temperature                 See model documentation |

<a name="new_Google.Google_new"></a>

#### new Google(logger, user, prompt, options, location, model)
Creates an instance of Google LLM.


| Param | Type | Description |
| --- | --- | --- |
| logger | <code>Object</code> | Pino logger instance |
| user | <code>string</code> | a unique user ID |
| prompt | <code>string</code> | The initial (system) chat prompt |
| options | <code>Object</code> | options |
| options.temperature | <code>number</code> | The LLM temperature                 See model documentation |
| location | <code>string</code> | Google service location |
| model | <code>string</code> | Google model name |

<a name="Google.Google"></a>

### Google.Google
**Kind**: static class of [<code>Google</code>](#Google)  

* [.Google](#Google.Google)
    * [new Google(logger, user, prompt, options)](#new_Google.Google_new)
    * [new Google(logger, user, prompt, options, location, model)](#new_Google.Google_new)

<a name="new_Google.Google_new"></a>

#### new Google(logger, user, prompt, options)
Creates an instance of Google LLM.


| Param | Type | Description |
| --- | --- | --- |
| logger | <code>Object</code> | Pino logger instance |
| user | <code>string</code> | a unique user ID |
| prompt | <code>string</code> | The initial (system) chat prompt |
| options | <code>Object</code> | options |
| options.temperature | <code>number</code> | The LLM temperature                 See model documentation |

<a name="new_Google.Google_new"></a>

#### new Google(logger, user, prompt, options, location, model)
Creates an instance of Google LLM.


| Param | Type | Description |
| --- | --- | --- |
| logger | <code>Object</code> | Pino logger instance |
| user | <code>string</code> | a unique user ID |
| prompt | <code>string</code> | The initial (system) chat prompt |
| options | <code>Object</code> | options |
| options.temperature | <code>number</code> | The LLM temperature                 See model documentation |
| location | <code>string</code> | Google service location |
| model | <code>string</code> | Google model name |

<a name="Google.supportsFunctions"></a>

### Google.supportsFunctions
Gemini Pro (only) via the VertexAI API supports function calling

**Kind**: static property of [<code>Google</code>](#Google)  
<a name="Google"></a>

## Google ⇐ [<code>Llm</code>](#Llm)
**Kind**: global class  
**Extends**: [<code>Llm</code>](#Llm)  

* [Google](#Google) ⇐ [<code>Llm</code>](#Llm)
    * [new Google()](#new_Google_new)
    * [new Google()](#new_Google_new)
    * _instance_
        * [.voiceHints](#Llm+voiceHints)
        * [.initial()](#Google+initial) ⇒ <code>string</code>
        * [.rawCompletion(input)](#Google+rawCompletion) ⇒ <code>string</code>
        * [.initial()](#Google+initial) ⇒ <code>string</code>
        * [.rawCompletion(input)](#Google+rawCompletion) ⇒ <code>string</code>
        * [.completion(input)](#Llm+completion) ⇒ [<code>Completion</code>](#Completion)
    * _static_
        * [.Google](#Google.Google)
            * [new Google(logger, user, prompt, options)](#new_Google.Google_new)
            * [new Google(logger, user, prompt, options, location, model)](#new_Google.Google_new)
        * [.Google](#Google.Google)
            * [new Google(logger, user, prompt, options)](#new_Google.Google_new)
            * [new Google(logger, user, prompt, options, location, model)](#new_Google.Google_new)
        * [.supportsFunctions](#Google.supportsFunctions)

<a name="new_Google_new"></a>

### new Google()
Implements the LLM class for Google's Google model via the Vertex AI
interface.

<a name="new_Google_new"></a>

### new Google()
Implements the LLM class for Google's Vertex AI platform
interface.

<a name="Llm+voiceHints"></a>

### google.voiceHints
A list of all the unique words in the initial prompt.
Useful as hints for STT context priming.

**Kind**: instance property of [<code>Google</code>](#Google)  
**Overrides**: [<code>voiceHints</code>](#Llm+voiceHints)  
**Read only**: true  
<a name="Google+initial"></a>

### google.initial() ⇒ <code>string</code>
Start the chat session and return the initial greeting

**Kind**: instance method of [<code>Google</code>](#Google)  
**Returns**: <code>string</code> - initial response  
<a name="Google+rawCompletion"></a>

### google.rawCompletion(input) ⇒ <code>string</code>
Generate the next round of chat response

**Kind**: instance method of [<code>Google</code>](#Google)  
**Returns**: <code>string</code> - the raw completion output from Google model  

| Param | Type | Description |
| --- | --- | --- |
| input | <code>string</code> | the user prompt input text |

<a name="Google+initial"></a>

### google.initial() ⇒ <code>string</code>
Start the chat session and return the initial greeting

**Kind**: instance method of [<code>Google</code>](#Google)  
**Returns**: <code>string</code> - initial response  
<a name="Google+rawCompletion"></a>

### google.rawCompletion(input) ⇒ <code>string</code>
Generate the next round of chat response

**Kind**: instance method of [<code>Google</code>](#Google)  
**Returns**: <code>string</code> - the raw completion output from Google model  

| Param | Type | Description |
| --- | --- | --- |
| input | <code>string</code> | the user prompt input text |

<a name="Llm+completion"></a>

### google.completion(input) ⇒ [<code>Completion</code>](#Completion)
Parse a raw completion, return speech text, data and hangup signal

**Kind**: instance method of [<code>Google</code>](#Google)  
**Overrides**: [<code>completion</code>](#Llm+completion)  
**Returns**: [<code>Completion</code>](#Completion) - completion parsed completion  

| Param | Type | Description |
| --- | --- | --- |
| input | <code>string</code> | raw completion |

<a name="Google.Google"></a>

### Google.Google
**Kind**: static class of [<code>Google</code>](#Google)  

* [.Google](#Google.Google)
    * [new Google(logger, user, prompt, options)](#new_Google.Google_new)
    * [new Google(logger, user, prompt, options, location, model)](#new_Google.Google_new)

<a name="new_Google.Google_new"></a>

#### new Google(logger, user, prompt, options)
Creates an instance of Google LLM.


| Param | Type | Description |
| --- | --- | --- |
| logger | <code>Object</code> | Pino logger instance |
| user | <code>string</code> | a unique user ID |
| prompt | <code>string</code> | The initial (system) chat prompt |
| options | <code>Object</code> | options |
| options.temperature | <code>number</code> | The LLM temperature                 See model documentation |

<a name="new_Google.Google_new"></a>

#### new Google(logger, user, prompt, options, location, model)
Creates an instance of Google LLM.


| Param | Type | Description |
| --- | --- | --- |
| logger | <code>Object</code> | Pino logger instance |
| user | <code>string</code> | a unique user ID |
| prompt | <code>string</code> | The initial (system) chat prompt |
| options | <code>Object</code> | options |
| options.temperature | <code>number</code> | The LLM temperature                 See model documentation |
| location | <code>string</code> | Google service location |
| model | <code>string</code> | Google model name |

<a name="Google.Google"></a>

### Google.Google
**Kind**: static class of [<code>Google</code>](#Google)  

* [.Google](#Google.Google)
    * [new Google(logger, user, prompt, options)](#new_Google.Google_new)
    * [new Google(logger, user, prompt, options, location, model)](#new_Google.Google_new)

<a name="new_Google.Google_new"></a>

#### new Google(logger, user, prompt, options)
Creates an instance of Google LLM.


| Param | Type | Description |
| --- | --- | --- |
| logger | <code>Object</code> | Pino logger instance |
| user | <code>string</code> | a unique user ID |
| prompt | <code>string</code> | The initial (system) chat prompt |
| options | <code>Object</code> | options |
| options.temperature | <code>number</code> | The LLM temperature                 See model documentation |

<a name="new_Google.Google_new"></a>

#### new Google(logger, user, prompt, options, location, model)
Creates an instance of Google LLM.


| Param | Type | Description |
| --- | --- | --- |
| logger | <code>Object</code> | Pino logger instance |
| user | <code>string</code> | a unique user ID |
| prompt | <code>string</code> | The initial (system) chat prompt |
| options | <code>Object</code> | options |
| options.temperature | <code>number</code> | The LLM temperature                 See model documentation |
| location | <code>string</code> | Google service location |
| model | <code>string</code> | Google model name |

<a name="Google.supportsFunctions"></a>

### Google.supportsFunctions
Gemini Pro (only) via the VertexAI API supports function calling

**Kind**: static property of [<code>Google</code>](#Google)  
<a name="OpenAi"></a>

## OpenAi ⇐ [<code>Llm</code>](#Llm)
**Kind**: global class  
**Extends**: [<code>Llm</code>](#Llm)  

* [OpenAi](#OpenAi) ⇐ [<code>Llm</code>](#Llm)
    * [new OpenAi(logger, user, prompt, options)](#new_OpenAi_new)
    * _instance_
        * [.voiceHints](#Llm+voiceHints)
        * [.initial()](#OpenAi+initial) ⇒ <code>string</code>
        * [.rawCompletion(input)](#OpenAi+rawCompletion) ⇒ <code>string</code>
        * [.callResult(Array)](#OpenAi+callResult) ⇒
        * [.completion(input)](#Llm+completion) ⇒ [<code>Completion</code>](#Completion)
    * _static_
        * [.OpenAi](#OpenAi.OpenAi)
            * [new OpenAi()](#new_OpenAi.OpenAi_new)
        * [.supportsFunctions](#OpenAi.supportsFunctions)
        * [.Google#callResult(Array)](#OpenAi.Google+callResult) ⇒

<a name="new_OpenAi_new"></a>

### new OpenAi(logger, user, prompt, options)
Implements the LLM class against the OpenAI GPT3.5-turbo model


| Param | Type | Description |
| --- | --- | --- |
| logger | <code>Object</code> | Pino logger instance |
| user | <code>string</code> | a unique user ID |
| prompt | <code>string</code> | The initial (system) chat prompt |
| options | <code>Object</code> | options |
| options.temperature | <code>number</code> | The LLM temperature                 See model documentation |

<a name="Llm+voiceHints"></a>

### openAi.voiceHints
A list of all the unique words in the initial prompt.
Useful as hints for STT context priming.

**Kind**: instance property of [<code>OpenAi</code>](#OpenAi)  
**Read only**: true  
<a name="OpenAi+initial"></a>

### openAi.initial() ⇒ <code>string</code>
Start the chat session and return the initial greeting

**Kind**: instance method of [<code>OpenAi</code>](#OpenAi)  
**Returns**: <code>string</code> - initial response  
<a name="OpenAi+rawCompletion"></a>

### openAi.rawCompletion(input) ⇒ <code>string</code>
Generate the next round of chat response

**Kind**: instance method of [<code>OpenAi</code>](#OpenAi)  
**Returns**: <code>string</code> - the raw completion output from the GPT-3.5 model  

| Param | Type | Description |
| --- | --- | --- |
| input | <code>string</code> | the user prompt input text |

<a name="OpenAi+callResult"></a>

### openAi.callResult(Array) ⇒
Send a set of function call results back to generate the next round of responses

**Kind**: instance method of [<code>OpenAi</code>](#OpenAi)  
**Returns**: the rawCompletion output  

| Param | Type | Description |
| --- | --- | --- |
| Array | <code>Array</code> | of id, result string tuples |

<a name="Llm+completion"></a>

### openAi.completion(input) ⇒ [<code>Completion</code>](#Completion)
Parse a raw completion, return speech text, data and hangup signal

**Kind**: instance method of [<code>OpenAi</code>](#OpenAi)  
**Returns**: [<code>Completion</code>](#Completion) - completion parsed completion  

| Param | Type | Description |
| --- | --- | --- |
| input | <code>string</code> | raw completion |

<a name="OpenAi.OpenAi"></a>

### OpenAi.OpenAi
**Kind**: static class of [<code>OpenAi</code>](#OpenAi)  
<a name="new_OpenAi.OpenAi_new"></a>

#### new OpenAi()
Creates an instance of OpenAi.

<a name="OpenAi.supportsFunctions"></a>

### OpenAi.supportsFunctions
OpenAI implementation supports function calling

**Kind**: static property of [<code>OpenAi</code>](#OpenAi)  
<a name="OpenAi.Google+callResult"></a>

### OpenAi.Google#callResult(Array) ⇒
Send a set of function call results back to generate the next round of responses

**Kind**: static method of [<code>OpenAi</code>](#OpenAi)  
**Returns**: the rawCompletion output  

| Param | Type | Description |
| --- | --- | --- |
| Array | <code>Array</code> | of id, result string tuples |

<a name="Palm2"></a>

## Palm2 ⇐ [<code>Llm</code>](#Llm)
**Kind**: global class  
**Extends**: [<code>Llm</code>](#Llm)  

* [Palm2](#Palm2) ⇐ [<code>Llm</code>](#Llm)
    * [new Palm2()](#new_Palm2_new)
    * _instance_
        * [.voiceHints](#Llm+voiceHints)
        * [.completion(input)](#Llm+completion) ⇒ [<code>Completion</code>](#Completion)
    * _static_
        * [.Palm2](#Palm2.Palm2)
            * [new Palm2(logger, user, prompt, options)](#new_Palm2.Palm2_new)

<a name="new_Palm2_new"></a>

### new Palm2()
Implements the LLM class for Google's PaLM2 model via the Vertex AI
interface.

<a name="Llm+voiceHints"></a>

### palm2.voiceHints
A list of all the unique words in the initial prompt.
Useful as hints for STT context priming.

**Kind**: instance property of [<code>Palm2</code>](#Palm2)  
**Read only**: true  
<a name="Llm+completion"></a>

### palm2.completion(input) ⇒ [<code>Completion</code>](#Completion)
Parse a raw completion, return speech text, data and hangup signal

**Kind**: instance method of [<code>Palm2</code>](#Palm2)  
**Returns**: [<code>Completion</code>](#Completion) - completion parsed completion  

| Param | Type | Description |
| --- | --- | --- |
| input | <code>string</code> | raw completion |

<a name="Palm2.Palm2"></a>

### Palm2.Palm2
**Kind**: static class of [<code>Palm2</code>](#Palm2)  
<a name="new_Palm2.Palm2_new"></a>

#### new Palm2(logger, user, prompt, options)
Creates an instance of Palm2.


| Param | Type | Description |
| --- | --- | --- |
| logger | <code>Object</code> | Pino logger instance |
| user | <code>string</code> | a unique user ID |
| prompt | <code>string</code> | The initial (system) chat prompt |
| options | <code>Object</code> | options |
| options.temperature | <code>number</code> | The LLM temperature                 See model documentation |

<a name="Completion"></a>

## Completion : <code>Object</code>
**Kind**: global typedef  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| text | <code>string</code> | parsed text string with \n's translated to breaks and directives removed |
| data | <code>Object</code> | returned inline data object (or null of no returned data) |
| hangup | <code>boolean</code> | true if a @HANGUP inline directive is present in the raw completion |

<a name="CallHook"></a>

## CallHook : <code>Object</code>
**Kind**: global typedef  
**Description**: Configuration attached to an Agent (`agent.options.callHook`) or Listener (`listener.options.callHook`) to invoke an external URL when calls start and/or end.  
**Properties**

| Name | Type | Description |
| --- | --- | --- |
| url | <code>string</code> | Required. URL to POST to when the hook is triggered. |
| hashKey | <code>string</code> | Optional shared secret used to compute a request body hash (`hashKey \| callId \| listenerId \| agentId`). |
| includeTranscript | <code>boolean</code> | Optional. If true, the `end` event payload will include a transcript where available. |
| events | <code>Array.&lt;string&gt;</code> | Optional. Subset of `['start','end']` specifying which events should trigger the callback. Defaults to both when omitted. |


