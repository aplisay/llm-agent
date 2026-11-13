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

Last verified on 2026-11-13, on a new AWS account, with the `next` branch,
in the London region (`eu-west-2`). The AWS steps were done twice: once in
the web console (steps 1 to 3) and once with the AWS command line
([the same with the command line](#the-same-with-the-aws-command-line)).

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

## The same with the AWS command line

Steps 1 to 3 as commands, for a script or an assistant. You need the AWS
command line, version 2, signed in to your account (`aws login`, or
`aws configure`). Set the region once:

```shell
export AWS_REGION=eu-west-2
```

Key pair and firewall. The first rule lets SSH in from your own address only:

```shell
aws ec2 import-key-pair --key-name aplisay \
  --public-key-material fileb://$HOME/.ssh/id_ed25519.pub

VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 create-security-group --group-name aplisay \
  --description "Aplisay self-host" --vpc-id "$VPC" \
  --query GroupId --output text)
MYIP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress --group-id "$SG" \
  --protocol tcp --port 22 --cidr "$MYIP/32"
```

The instance. The image is the current Ubuntu 26.04, looked up by name so
that the command does not go stale:

```shell
AMI=$(aws ssm get-parameter --query Parameter.Value --output text --name \
  /aws/service/canonical/ubuntu/server/26.04/stable/current/amd64/hvm/ebs-gp3/ami-id)
ROOTDEV=$(aws ec2 describe-images --image-ids "$AMI" \
  --query 'Images[0].RootDeviceName' --output text)
IID=$(aws ec2 run-instances --image-id "$AMI" --instance-type t3.medium \
  --key-name aplisay --security-group-ids "$SG" \
  --block-device-mappings "DeviceName=$ROOTDEV,Ebs={VolumeSize=40,VolumeType=gp3}" \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=aplisay}]' \
  --query 'Instances[0].InstanceId' --output text)
aws ec2 wait instance-running --instance-ids "$IID"
```

A fixed address:

```shell
ALLOC=$(aws ec2 allocate-address --query AllocationId --output text)
aws ec2 associate-address --instance-id "$IID" --allocation-id "$ALLOC"
aws ec2 describe-addresses --allocation-ids "$ALLOC" \
  --query 'Addresses[0].PublicIp' --output text
```

The last command prints your public IP address. SSH answers about half a
minute later.

For phone calls ([step 7](#7-phone-calls)), one rule for each of your
provider's signalling ranges, and one for audio:

```shell
aws ec2 authorize-security-group-ingress --group-id "$SG" \
  --protocol udp --port 5060 --cidr <provider signalling range>
aws ec2 authorize-security-group-ingress --group-id "$SG" \
  --protocol udp --port 10000-20000 --cidr 0.0.0.0/0
```

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

With the command line, using the names from
[the commands above](#the-same-with-the-aws-command-line):

```shell
aws ec2 terminate-instances --instance-ids "$IID"
aws ec2 wait instance-terminated --instance-ids "$IID"
aws ec2 release-address --allocation-id "$ALLOC"
aws ec2 delete-security-group --group-id "$SG"
aws ec2 delete-key-pair --key-name aplisay
```

The security group cannot be deleted until the instance has gone, which is
why the second line waits.

If you build again soon and want the same address, ask for it by name. This
works only while nobody else has been given it:

```shell
aws ec2 allocate-address --address <the old public IP>
```

## What was checked

On the date above, twice: once with the console steps and once with the
command-line steps, each on a new instance.

- Each console step on this page, on a new account.
- Each command in the command-line sections, including removal and taking a
  released address back.
- The install commands on Ubuntu 26.04, with Docker run without `sudo` after
  logging in again, and a healthy API.
- Adding a model key to `.env` and `docker compose up -d`: the health answer
  then shows the provider as enabled.
- The SSH tunnel to the API and the test page.
- The Pipecat worker and `sipbridge` beside the bundle, and an inbound call
  from a carrier with audio in both directions, on both instances.

Not checked: the `edge` profile with a domain name, a managed database,
other regions and other instance types.
