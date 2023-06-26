## Classes

<dl>
<dt><a href="#Application">Application</a></dt>
<dd></dd>
<dt><a href="#Gpt35">Gpt35</a> ⇐ <code><a href="#Llm">Llm</a></code></dt>
<dd></dd>
<dt><a href="#Jambonz">Jambonz</a></dt>
<dd></dd>
<dt><a href="#Llm">Llm</a></dt>
<dd></dd>
<dt><a href="#Palm2">Palm2</a> ⇐ <code><a href="#Llm">Llm</a></code></dt>
<dd></dd>
</dl>

## Typedefs

<dl>
<dt><a href="#Completion">Completion</a> : <code>Object</code></dt>
<dd></dd>
</dl>

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
        * [.listAgents()](#Application.listAgents) ⇒ <code>Array.&lt;Object&gt;</code>
        * [.clean()](#Application.clean) ⇒ <code>Promise</code>
        * [.cleanAll()](#Application.cleanAll)

<a name="new_Application_new"></a>

### new Application(params)
Create a new application


| Param | Type | Description |
| --- | --- | --- |
| params | <code>Object</code> | Application creation parameters |
| params.agentName | <code>string</code> | supported LLM agent name, must be one of #Application.agents |
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

<a name="Application.listAgents"></a>

### Application.listAgents() ⇒ <code>Array.&lt;Object&gt;</code>
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
<a name="Gpt35"></a>

## Gpt35 ⇐ [<code>Llm</code>](#Llm)
**Kind**: global class  
**Extends**: [<code>Llm</code>](#Llm)  

* [Gpt35](#Gpt35) ⇐ [<code>Llm</code>](#Llm)
    * [new Gpt35(logger, user, prompt, options)](#new_Gpt35_new)
    * _instance_
        * [.voiceHints](#Llm+voiceHints)
        * [.initial()](#Gpt35+initial) ⇒ <code>string</code>
        * [.rawCompletion(input)](#Gpt35+rawCompletion) ⇒ <code>string</code>
        * [.completion(input)](#Llm+completion) ⇒ [<code>Completion</code>](#Completion)
    * _static_
        * [.Gpt35](#Gpt35.Gpt35)
            * [new Gpt35()](#new_Gpt35.Gpt35_new)

<a name="new_Gpt35_new"></a>

### new Gpt35(logger, user, prompt, options)
Implements the LLM class against the OpenAI GPT3.5-turbo model

   * Creates an instance of Gpt35.


| Param | Type | Description |
| --- | --- | --- |
| logger | <code>Object</code> | Pino logger instance |
| user | <code>string</code> | a unique user ID |
| prompt | <code>string</code> | The initial (system) chat prompt |
| options | <code>Object</code> | options |
| options.temperature | <code>number</code> | The LLM temperature                 See model documentation |

<a name="Llm+voiceHints"></a>

### gpt35.voiceHints
A list of all the unique words in the initial prompt.
Useful as hints for STT context priming.

**Kind**: instance property of [<code>Gpt35</code>](#Gpt35)  
**Read only**: true  
<a name="Gpt35+initial"></a>

### gpt35.initial() ⇒ <code>string</code>
Start the chat session and return the initial greeting

**Kind**: instance method of [<code>Gpt35</code>](#Gpt35)  
**Returns**: <code>string</code> - initial response  
<a name="Gpt35+rawCompletion"></a>

### gpt35.rawCompletion(input) ⇒ <code>string</code>
Generate the next round of chat response

**Kind**: instance method of [<code>Gpt35</code>](#Gpt35)  
**Returns**: <code>string</code> - the raw completion output from the GPT-3.5 model  

| Param | Type | Description |
| --- | --- | --- |
| input | <code>string</code> | the user prompt input text |

<a name="Llm+completion"></a>

### gpt35.completion(input) ⇒ [<code>Completion</code>](#Completion)
Parse a raw completion, return speech text, data and hangup signal

**Kind**: instance method of [<code>Gpt35</code>](#Gpt35)  
**Returns**: [<code>Completion</code>](#Completion) - completion parsed completion  

| Param | Type | Description |
| --- | --- | --- |
| input | <code>string</code> | raw completion |

<a name="Gpt35.Gpt35"></a>

### Gpt35.Gpt35
**Kind**: static class of [<code>Gpt35</code>](#Gpt35)  
<a name="new_Gpt35.Gpt35_new"></a>

#### new Gpt35()
Creates an instance of Gpt35.

<a name="Jambonz"></a>

## Jambonz
**Kind**: global class  

* [Jambonz](#Jambonz)
    * [new Jambonz()](#new_Jambonz_new)
    * _instance_
        * [.listNumbers()](#Jambonz+listNumbers) ⇒ <code>Promise.&lt;Array.&lt;Object&gt;&gt;</code>
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

<a name="Palm2"></a>

## Palm2 ⇐ [<code>Llm</code>](#Llm)
**Kind**: global class  
**Extends**: [<code>Llm</code>](#Llm)  

* [Palm2](#Palm2) ⇐ [<code>Llm</code>](#Llm)
    * [new Palm2()](#new_Palm2_new)
    * _instance_
        * [.voiceHints](#Llm+voiceHints)
        * [.initial()](#Palm2+initial) ⇒ <code>string</code>
        * [.rawCompletion(input)](#Palm2+rawCompletion) ⇒ <code>string</code>
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
<a name="Palm2+initial"></a>

### palm2.initial() ⇒ <code>string</code>
Start the chat session and return the initial greeting

**Kind**: instance method of [<code>Palm2</code>](#Palm2)  
**Returns**: <code>string</code> - initial response  
<a name="Palm2+rawCompletion"></a>

### palm2.rawCompletion(input) ⇒ <code>string</code>
Generate the next round of chat response

**Kind**: instance method of [<code>Palm2</code>](#Palm2)  
**Returns**: <code>string</code> - the raw completion output from PaLM2 model  

| Param | Type | Description |
| --- | --- | --- |
| input | <code>string</code> | the user prompt input text |

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

