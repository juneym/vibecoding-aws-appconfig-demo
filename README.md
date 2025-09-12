# How to run



Setup the AWS Credentials and AWS AppConfig IDs & run the application
   
```bash

  APPCONFIG_APPLICATION_ID=<value> \
  export APPCONFIG_ENVIRONMENT_ID=<value> \
  export AWS_ACCESS_KEY_ID=<....value...>  \ 
  export AWS_SECRET_ACCESS_KEY=<...value...>  \
  export AWS_REGION=<value>   \
  export CONFIG_PREFIX="dev4_"  \
  npm start

```

2. Check the HTTP api endpoint

```bash
curl http://localhost:3000/configs_all
curl http://localhost:3000/config?name=feature_flags
```



