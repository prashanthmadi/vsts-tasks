/// <reference path="../typings/index.d.ts" />

import keyVaultTaskParameters = require("../models/KeyVaultTaskParameters");
import armKeyVault = require("./azure-arm-keyvault");
import util = require("util");
import tl = require("vsts-task-lib/task");

export class SecretsToErrorsMapping { 
    public errorsMap: { [key: string]: string; };

    constructor() {
        this.errorsMap = {};
    }

    public addError(secretName: string, errorMessage: string): void {
        this.errorsMap[secretName] = errorMessage;
    }

    public isEmpty(): boolean {
        for (var key in this.errorsMap) {
            return false;
        }

        return true;
    }

    public getAllErrors(): string {
        var allErrors = "";
        for (var key in this.errorsMap) {
            if (this.errorsMap.hasOwnProperty(key)) {
                var errorMessagePerSecret = key + ": " + this.errorsMap[key];
                allErrors = allErrors + "\n" + errorMessagePerSecret;
            }
        }

        return allErrors;
    }
}

export class KeyVault {

    private taskParameters: keyVaultTaskParameters.KeyVaultTaskParameters;
    private keyVaultClient: armKeyVault.KeyVaultClient;

    constructor(taskParameters: keyVaultTaskParameters.KeyVaultTaskParameters) {
        this.taskParameters = taskParameters;
        this.keyVaultClient = new armKeyVault.KeyVaultClient(
            this.taskParameters.vaultCredentials, 
            this.taskParameters.subscriptionId,
            this.taskParameters.keyVaultName,
            this.taskParameters.keyVaultUrl);
    }

    public downloadSecrets(secretsToErrorsMap: SecretsToErrorsMapping): Promise<void> {

        var downloadAllSecrets = false;
        if (this.taskParameters.secretsFilter && this.taskParameters.secretsFilter.length > 0)
        {
            if (this.taskParameters.secretsFilter.length === 1 && this.taskParameters.secretsFilter[0] === "*") {
                downloadAllSecrets = true;
            }
        } else {
            downloadAllSecrets = true;
        }

        console.log(tl.loc("SubscriptionIdLabel", this.taskParameters.subscriptionId));
        console.log(tl.loc("KeyVaultNameLabel", this.taskParameters.keyVaultName));

        if (downloadAllSecrets) {
            return this.downloadAllSecrets(secretsToErrorsMap);
        } else {
            return this.downloadSelectedSecrets(this.taskParameters.secretsFilter, secretsToErrorsMap);
        }
    }

    private downloadAllSecrets(secretsToErrorsMap: SecretsToErrorsMapping): Promise<void> {
        tl.debug(util.format("Downloading all secrets from subscriptionId: %s, vault: %s", this.taskParameters.subscriptionId, this.taskParameters.keyVaultName));

        return new Promise<void>((resolve, reject) => {
            this.keyVaultClient.getSecrets("", (error, listOfSecrets, request, response) => {
                if (error) {
                    return reject(tl.loc("GetSecretsFailed", this.getError(error)));
                }

                if (listOfSecrets.length == 0) {
                    console.log(tl.loc("NoSecretsFound", this.taskParameters.keyVaultName));
                    return resolve();
                }

                console.log(tl.loc("NumberOfSecretsFound", this.taskParameters.keyVaultName, listOfSecrets.length));
                listOfSecrets = this.filterDisabledAndExpiredSecrets(listOfSecrets);
                console.log(tl.loc("NumberOfEnabledSecretsFound", this.taskParameters.keyVaultName, listOfSecrets.length));

                var getSecretValuePromises: Promise<any>[] = [];
                listOfSecrets.forEach((secret: armKeyVault.AzureKeyVaultSecret, index: number) => {
                    getSecretValuePromises.push(this.downloadSecretValue(secret.name, secretsToErrorsMap));
                });

                Promise.all(getSecretValuePromises).then(() =>{
                    return resolve();
                });
            });
        });
    }

    private downloadSelectedSecrets(selectedSecrets: string[], secretsToErrorsMap: SecretsToErrorsMapping): Promise<void> {
        tl.debug(util.format("Downloading selected secrets from subscriptionId: %s, vault: %s", this.taskParameters.subscriptionId, this.taskParameters.keyVaultName));

        return new Promise<void>((resolve, reject) => {
            var getSecretValuePromises: Promise<any>[] = [];
            selectedSecrets.forEach((secretName: string, index: number) => {
                getSecretValuePromises.push(this.downloadSecretValue(secretName, secretsToErrorsMap));
            });

            Promise.all(getSecretValuePromises).then(() =>{
                return resolve();
            });
        });
    }

    private filterDisabledAndExpiredSecrets(listOfSecrets: armKeyVault.AzureKeyVaultSecret[]): armKeyVault.AzureKeyVaultSecret[] {
        var result: armKeyVault.AzureKeyVaultSecret[] = [];
        var now: Date = new Date();

        listOfSecrets.forEach((value: armKeyVault.AzureKeyVaultSecret, index: number) => {
            if (value.enabled && (!value.expires || value.expires > now)) {
                result.push(value);
            }
        });
        
        return result;
    }

    private downloadSecretValue(secretName: string, secretsToErrorsMap: SecretsToErrorsMapping): Promise<any> {
        tl.debug(util.format("Promise for downloading secret value for: %s", secretName));

        return new Promise<void>((resolve, reject) => {
            this.keyVaultClient.getSecretValue(secretName, (error, secretValue, request, response) => {
                if (error) {
                    let errorMessage = this.getError(error);
                    secretsToErrorsMap.addError(secretName, errorMessage);
                }
                else {
                    console.log("##vso[task.setvariable variable=" + secretName + ";issecret=true;]" + secretValue);
                }
                
                return resolve();
            });
        });
    }

    private getError(error: any) {
        tl.debug(JSON.stringify(error));

        if (error && error.message && error.statusCode && error.statusCode == 403) {
            return tl.loc("AccessDeniedError", error.message);
        }

        if (error && error.message) {
            return error.message;
        }

        return error;
    }
}