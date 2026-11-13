---
title: Deploy on AWS (one EC2 instance)
description: Step by step, how to run the whole platform on a single EC2 instance, from a new AWS account to a working API, with the firewall rules for phone calls.
audience: operator
status: current
---

# Deploy on AWS (one EC2 instance)

This puts the whole compose bundle on one EC2 instance: the API server,
PostgreSQL, a LiveKit server, the LiveKit worker and the test page. It is the
"single VM" layout. It suits a trial, a pilot or a small private deployment.

Last verified on 2026-11-13, on a new AWS account, with the `next` branch at
`d4acb57`, in the London region (`eu-west-2`). The AWS steps were done in the
web console, as written here. They were not run with the AWS command line.

## What you need

- An AWS account, and a user that can work with EC2: launch instances, and
  create key pairs, security groups and Elastic IP addresses.
- An SSH key pair on your computer. `ssh-keygen -t ed25519` makes one.
- A model provider key, for example an OpenAI API key, if you want to talk to
  an agent.

## What it costs

You pay by the hour for the instance, its disk and the Elastic IP address,
until you remove them. The instance type below was listed at 0.0472 USD an
hour in London on the date above. Check the current price in the console.
[Remove it all](#remove-it-all) when you are done.

## 1. Import your SSH key

In the EC2 console, choose your region at the top right. Then:

1. Open **Key Pairs** (under Network & Security) and choose **Actions**,
   **Import key pair**.
2. Give it a name.
3. Paste the contents of your public key file, for example
   `~/.ssh/id_ed25519.pub`.
4. Choose **Import key pair**.

## 2. Launch the instance

Open **Instances** and choose **Launch instances**. Set these and leave the
rest:

| Setting | Value |
|---|---|
| Name | Any, for example `aplisay` |
| Application and OS Images | **Ubuntu**. The default, Ubuntu Server 26.04 LTS, 64-bit (x86), was used here |
| Instance type | `t3.medium` (2 vCPU, 4 GiB). See [Size](#size) |
| Key pair | The one you imported |
| Network settings | **Create security group**. Tick **Allow SSH traffic from** and change **Anywhere** to **My IP** |
| Configure storage | Change the root volume from 8 to **40** GiB |

Choose **Launch instance**.

Do not open SSH to "Anywhere". The form warns about it for good reason.

## 3. Give it a fixed address

An instance's public address changes when it stops and starts. A phone
provider needs one that does not.

1. Open **Elastic IPs** and choose **Allocate Elastic IP address**, then
   **Allocate**.
2. Choose **Associate this Elastic IP address** in the green banner.
3. Under **Instance**, choose your instance. Choose **Associate**.

The address shown is your public IP address. The rest of this page calls it
`<public IP>`.

## 4. Install

Sign in:

```shell
ssh -i ~/.ssh/id_ed25519 ubuntu@<public IP>
```

Install Docker and git from Ubuntu's own packages, then log out and in again
so that your user can run Docker:

```shell
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker ubuntu
exit
```

Sign in again. Then follow the [local quickstart](quickstart-local.md). In
short:

```shell
git clone https://github.com/aplisay/llm-agent.git
cd llm-agent
scripts/compose-setup.sh        # prints the first API key; keep it
docker compose up --build -d
curl http://localhost:4000/api/health
```

The first build took about 9 minutes on this instance type and left 18 GB of
the disk in use. The health answer should start `{"status":"ok"`.

The packages gave Docker 29.1 and Compose 2.40. Compose 2.24 or later is
needed.

## 5. Add a model key

Until a model provider key is set, the health answer carries the warning "no
model provider key is set: no agent can run".

```shell
nano .env                       # add a line: OPENAI_API_KEY=...
docker compose up -d
```

## 6. Reach it from your computer

The bundle listens on the instance's loopback address only. Nothing is open
to the internet except SSH from your address. To use the API and the test
page from your computer, open a tunnel:

```shell
ssh -i ~/.ssh/id_ed25519 -L 4000:localhost:4000 -L 8080:localhost:8080 ubuntu@<public IP>
```

While that is open, `http://localhost:4000/api/health` and the test page at
`http://localhost:8080` work on your computer. Carry on with "Talk to an
agent" in the [local quickstart](quickstart-local.md).

To serve the API to other people, put HTTPS in front of it. The `edge`
profile in `compose.yaml` does this and needs a domain name. See
[production-checklist.md](production-checklist.md). It was not part of this
run.

## 7. Phone calls

Follow [byo-trunk-sipbridge.md](byo-trunk-sipbridge.md) for your own SIP
trunk on the Pipecat runtime. This run did that, and took a real call from a
UK carrier. The AWS parts are:

- `EXT_IP_ADDRESS` is the Elastic IP address. The instance itself holds only
  a private address, and AWS maps the public one to it. That works as it is.
- Open the ports in the instance's security group. Open **Security Groups**,
  choose the group, then **Edit inbound rules** and **Add rule** for each
  line:

  | Type | Port range | Source | For |
  |---|---|---|---|
  | Custom UDP | 5060 | Your provider's signalling range | SIP |
  | Custom UDP | 10000 - 20000 | Your provider's media ranges, or Anywhere-IPv4 | Audio |

- A rule takes one source. A provider with four signalling ranges needs four
  rules for port 5060.
- A provider's audio often comes from other addresses than its signalling.
  In this run the SIP came from one range and the audio from another. If you
  limit the audio rule, use the provider's media ranges, not its signalling
  addresses, or the call connects in silence.
- The Pipecat worker and `sipbridge` added about 4 minutes of build time and
  4 GB of disk.

## Size

With both stacks running and idle (the compose bundle, the Pipecat worker
and `sipbridge`), the 4 GiB instance had 1.7 GiB in use and 22 GB of the
40 GB disk. The image builds are the heaviest moment. A smaller instance or
the default 8 GiB disk will not get through them.

## Remove it all

In the EC2 console:

1. **Instances**: select the instance, then **Instance state**, **Terminate
   instance**. The disk goes with it, and all data on it.
2. **Elastic IPs**: select the address, then **Actions**, **Release Elastic
   IP addresses**. An address you keep is charged even with no instance.
3. **Security Groups**: delete the group the launch form created.
4. **Key Pairs**: delete the key pair if you no longer need it.

Tell your phone provider to stop sending calls to the address first.

## What was checked

On the date and version above:

- Each console step on this page, on a new account.
- The install commands on Ubuntu 26.04, and a healthy API.
- The SSH tunnel to the API and the test page.
- The Pipecat worker and `sipbridge` beside the bundle, and an inbound call
  from a carrier with audio in both directions.

Not checked: the AWS command line, the `edge` profile with a domain name, a
managed database, other regions and other instance types.
