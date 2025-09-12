# How to run



1. Setup the AWS Credentials and AWS AppConfig IDs
   
```bash
  export APPCONFIG_APPLICATION_ID=<value>
  export APPCONFIG_ENVIRONMENT_ID=<value>
  export AWS_ACCESS_KEY_ID=<....value...>
  export AWS_SECRET_ACCESS_KEY=<...value...>
  export AWS_REGION=<value>
  export CONFIG_PREFIX="dev4_"
```

2. Run the application

```bash
npm start
```

3. Check the HTTP api endpoint

```bash
curl http://localhost:3000/configs_all
curl http://localhost:3000/config?name=feature_flags
```



